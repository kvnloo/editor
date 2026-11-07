import type { DeepZoomZipArtifactHost } from './deep-zoom-zip'

export type GigapixelArtifactEntry =
  | { kind: 'zip-chunk'; bytes: Uint8Array }
  | { kind: 'tile' }

export interface GigapixelArtifactReceipt {
  bytes: number
  sha256: string
  tileCount: number
}

export interface GigapixelArtifactSink {
  write(entry: GigapixelArtifactEntry): Promise<void>
  finish(): Promise<GigapixelArtifactReceipt>
  abort(): Promise<void>
}

export interface InMemoryGigapixelArtifactSink extends GigapixelArtifactSink {
  blob(): Blob
}

const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]

const rotateRight = (word: number, bits: number): number =>
  (word >>> bits) | (word << (32 - bits))

/** Incremental SHA-256: Web Crypto digest() requires the whole ZIP in memory. */
class ZipSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private used = 0
  private length = 0

  update(bytes: Uint8Array): void {
    if (!Number.isSafeInteger(this.length + bytes.length)) {
      throw new RangeError('DeepZoom archive byte count is not a safe integer')
    }
    this.length += bytes.length
    let offset = 0
    while (offset < bytes.length) {
      const count = Math.min(64 - this.used, bytes.length - offset)
      this.block.set(bytes.subarray(offset, offset + count), this.used)
      this.used += count
      offset += count
      if (this.used === 64) {
        this.compress()
        this.used = 0
      }
    }
  }

  digestHex(): string {
    this.block[this.used++] = 0x80
    if (this.used > 56) {
      this.block.fill(0, this.used)
      this.compress()
      this.used = 0
    }
    this.block.fill(0, this.used, 56)
    const bits = BigInt(this.length) * 8n
    for (let i = 0; i < 8; i++) {
      this.block[56 + i] = Number((bits >> BigInt((7 - i) * 8)) & 255n)
    }
    this.compress()
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('')
  }

  private compress(): void {
    const words = this.words
    const block = this.block
    for (let i = 0; i < 16; i++) {
      const at = i * 4
      words[i] =
        ((block[at]! << 24) | (block[at + 1]! << 16) |
          (block[at + 2]! << 8) | block[at + 3]!) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const previous = words[i - 15]!
      const older = words[i - 2]!
      const s0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3)
      const s1 = rotateRight(older, 17) ^ rotateRight(older, 19) ^ (older >>> 10)
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = this.state
    for (let i = 0; i < 64; i++) {
      const choice = (e! & f!) ^ (~e! & g!)
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25)
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22)
      const t1 = (h! + s1 + choice + SHA256_ROUNDS[i]! + words[i]!) >>> 0
      const t2 = (s0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    const result = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i++) {
      this.state[i] = (this.state[i]! + result[i]!) >>> 0
    }
  }
}

/**
 * Re-read the published File or Blob from its actual storage handle. A matching
 * length alone is insufficient: disk publication must match the streamed receipt.
 * The readback uses bounded chunks rather than buffering a gigapixel ZIP.
 */
export async function verifyGigapixelArtifactReadback(
  blob: Blob,
  receipt: Pick<GigapixelArtifactReceipt, 'bytes' | 'sha256'>,
): Promise<void> {
  if (blob.size !== receipt.bytes) {
    throw new Error('Published DeepZoom ZIP length differs from its receipt')
  }
  const hasher = new ZipSha256()
  const reader = blob.stream().getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!Number.isSafeInteger(bytes + value.byteLength)) {
        throw new RangeError('Published DeepZoom ZIP byte count is not a safe integer')
      }
      hasher.update(value)
      bytes += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (bytes !== receipt.bytes || hasher.digestHex() !== receipt.sha256) {
    throw new Error('Published DeepZoom ZIP does not match its streamed SHA-256 receipt')
  }
}

interface ChunkDestination {
  write(bytes: Uint8Array): Promise<void>
  finish(): Promise<void>
  abort(): Promise<void>
}

function createArtifactSink(destination: ChunkDestination): GigapixelArtifactSink {
  const hash = new ZipSha256()
  let bytes = 0
  let tileCount = 0
  let state: 'open' | 'finished' | 'aborted' = 'open'
  return {
    async write(entry) {
      if (state !== 'open') throw new Error('DeepZoom artifact sink is no longer open')
      if (entry.kind === 'tile') {
        tileCount += 1
        return
      }
      if (!(entry.bytes instanceof Uint8Array)) {
        throw new TypeError('ZIP chunk must be a Uint8Array')
      }
      // The producer may reuse its buffer after write() resolves.
      const chunk = entry.bytes.slice()
      if (!Number.isSafeInteger(bytes + chunk.length)) {
        throw new RangeError('DeepZoom archive byte count is not a safe integer')
      }
      await destination.write(chunk)
      hash.update(chunk)
      bytes += chunk.length
    },
    async finish() {
      if (state !== 'open') throw new Error('DeepZoom artifact sink is no longer open')
      await destination.finish()
      state = 'finished'
      return { bytes, sha256: hash.digestHex(), tileCount }
    },
    async abort() {
      if (state !== 'open') return
      state = 'aborted'
      await destination.abort()
    },
  }
}

/** A Blob for the existing snapshot host; no incomplete Blob can be read. */
export function createInMemoryGigapixelArtifactSink(): InMemoryGigapixelArtifactSink {
  const chunks: Uint8Array[] = []
  let complete = false
  const sink = createArtifactSink({
    async write(bytes) {
      chunks.push(bytes)
    },
    async finish() {
      complete = true
    },
    async abort() {
      chunks.length = 0
    },
  })
  return {
    ...sink,
    blob() {
      if (!complete) throw new Error('DeepZoom artifact has not been committed')
      return new Blob(chunks, { type: 'application/zip' })
    },
  }
}

/** Host-approved file/Blob stream; each write awaits downstream backpressure. */
export function createWritableGigapixelArtifactSink(
  stream: WritableStream<Uint8Array>,
): GigapixelArtifactSink {
  const writer = stream.getWriter()
  return createArtifactSink({
    write: (chunk) => writer.write(chunk),
    finish: () => writer.close(),
    abort: () => writer.abort(new DOMException('DeepZoom capture aborted', 'AbortError')),
  })
}

/** Stages chunks under host authority and commits only after ZIP finalization. */
export interface StagedGigapixelArtifactSink extends GigapixelArtifactSink {
  /** Identity-safe rollback also works if the caller rejects a completed delivery. */
  rollback(): Promise<void>
}

export async function createStagedGigapixelArtifactSink(
  host: DeepZoomZipArtifactHost,
  filename: string,
): Promise<StagedGigapixelArtifactSink> {
  if (!/^[\p{L}\p{N}_][\p{L}\p{N} ._-]*\.zip$/u.test(filename)) {
    throw new RangeError('filename must be a safe ZIP basename')
  }
  const staged = await host.stage()
  const sink = createArtifactSink({
    write: (bytes) => Promise.resolve(staged.write(bytes)),
    finish: () => Promise.resolve(staged.publish(filename)),
    abort: () => Promise.resolve(staged.discard()),
  })
  return {
    ...sink,
    rollback: () => Promise.resolve(staged.discard()),
  }
}
