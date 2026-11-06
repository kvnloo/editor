import { describe, expect, test } from 'bun:test'
import { type DeepZoomZipTile, streamDeepZoomZip } from '@pascal-app/editor/deep-zoom-zip'
import { deepZoomDescriptor } from '@pascal-app/viewer/capture'
import { strFromU8, unzipSync } from 'fflate'

const descriptorOptions = {
  width: 2,
  height: 2,
  tileSize: 1,
  overlap: 0,
  format: 'webp',
}

const pyramid: DeepZoomZipTile[] = [
  { level: 0, col: 0, row: 0, bytes: Uint8Array.from([0, 255]) },
  { level: 1, col: 0, row: 0, bytes: Uint8Array.from([10]) },
  { level: 1, col: 1, row: 0, bytes: Uint8Array.from([11, 12]) },
  { level: 1, col: 0, row: 1, bytes: Uint8Array.from([13, 14, 15]) },
  { level: 1, col: 1, row: 1, bytes: Uint8Array.from([16]) },
]

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function localZipEntryNames(chunks: Uint8Array[]): string[] {
  const archive = concatenate(chunks)
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const names: string[] = []

  for (let offset = 0; offset <= archive.length - 30; offset++) {
    if (view.getUint32(offset, true) !== 0x04034b50) {
      continue
    }
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const nameEnd = nameStart + nameLength
    if (nameEnd + extraLength > archive.length) {
      throw new RangeError('truncated ZIP local file header')
    }
    names.push(strFromU8(archive.subarray(nameStart, nameEnd)))
    offset = nameEnd + extraLength - 1
  }

  return names
}

describe('streamDeepZoomZip', () => {
  test('streams a two-level pyramid with exact entries and bytes', async () => {
    const chunks: Uint8Array[] = []
    let emittedBytes = 0

    async function* tileSource(): AsyncGenerator<DeepZoomZipTile> {
      for (const tile of pyramid) {
        const before = emittedBytes
        yield tile
        expect(emittedBytes).toBeGreaterThan(before)
      }
    }

    await streamDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      tileSource(),
      (chunk) => {
        chunks.push(chunk.slice())
        emittedBytes += chunk.length
      },
    )

    const entries = unzipSync(concatenate(chunks))
    expect(Object.keys(entries)).toEqual([
      'scan.dzi',
      'scan_files/0/0_0.webp',
      'scan_files/1/0_0.webp',
      'scan_files/1/1_0.webp',
      'scan_files/1/0_1.webp',
      'scan_files/1/1_1.webp',
    ])
    expect(strFromU8(entries['scan.dzi']!)).toBe(deepZoomDescriptor(descriptorOptions))
    for (const tile of pyramid) {
      const path = 'scan_files/' + tile.level + '/' + tile.col + '_' + tile.row + '.webp'
      expect(entries[path]).toEqual(tile.bytes)
    }
  })

  test('waits for an async sink before requesting the next tile', async () => {
    const events: string[] = []
    const chunks: Uint8Array[] = []
    let releaseSink!: () => void
    const slowSink = new Promise<void>((resolve) => {
      releaseSink = resolve
    })
    let sinkStarted!: () => void
    const started = new Promise<void>((resolve) => {
      sinkStarted = resolve
    })
    let emittedFirstTile = false
    let blocked = false

    async function* tileSource(): AsyncGenerator<DeepZoomZipTile> {
      events.push('tile:0')
      emittedFirstTile = true
      yield pyramid[0]!
      expect(events).toContain('sink:resumed')
      events.push('tile:1')
      yield pyramid[1]!
    }

    const write = streamDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      tileSource(),
      async (chunk) => {
        if (emittedFirstTile && !blocked) {
          blocked = true
          events.push('sink:waiting')
          sinkStarted()
          await slowSink
          events.push('sink:resumed')
        }
        chunks.push(chunk.slice())
      },
    )

    await started
    const beforeRelease = [...events]
    releaseSink()
    await write
    expect(beforeRelease).toEqual(['tile:0', 'sink:waiting'])
    expect(events).toEqual(['tile:0', 'sink:waiting', 'sink:resumed', 'tile:1'])
    expect(Object.keys(unzipSync(concatenate(chunks)))).toEqual([
      'scan.dzi',
      'scan_files/0/0_0.webp',
      'scan_files/1/0_0.webp',
    ])
  })

  test('keeps synchronous sink output byte-identical to an async sink', async () => {
    const syncChunks: Uint8Array[] = []
    const asyncChunks: Uint8Array[] = []

    await Promise.all([
      streamDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, (chunk) => {
        syncChunks.push(chunk.slice())
      }),
      streamDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, async (chunk) => {
        await Promise.resolve()
        asyncChunks.push(chunk.slice())
      }),
    ])

    expect(concatenate(syncChunks)).toEqual(concatenate(asyncChunks))
  })

  test('rejects a failing async sink before requesting another tile', async () => {
    const events: string[] = []
    let emittedFirstTile = false
    const failure = new Error('sink could not persist ZIP chunk')

    async function* tileSource(): AsyncGenerator<DeepZoomZipTile> {
      events.push('tile:0')
      emittedFirstTile = true
      yield pyramid[0]!
      events.push('tile:1')
      yield pyramid[1]!
    }

    await expect(
      streamDeepZoomZip({ name: 'scan', ...descriptorOptions }, tileSource(), () => {
        if (emittedFirstTile) return Promise.reject(failure)
      }),
    ).rejects.toBe(failure)
    expect(events).toEqual(['tile:0'])
  })

  test('aborts between tiles without writing the second tile and cleans up once', async () => {
    const controller = new AbortController()
    const chunks: Uint8Array[] = []
    let cleanup = 0
    let tilesDelivered = 0

    async function* tileSource(): AsyncGenerator<DeepZoomZipTile> {
      tilesDelivered++
      yield pyramid[0]!
      controller.abort()
      tilesDelivered++
      yield pyramid[1]!
    }

    await expect(
      streamDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          signal: controller.signal,
          onCleanup: () => {
            cleanup++
          },
        },
        tileSource(),
        (chunk) => {
          chunks.push(chunk.slice())
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(tilesDelivered).toBe(2)
    expect(cleanup).toBe(1)
    const entryNames = localZipEntryNames(chunks)
    expect(entryNames).toEqual(['scan.dzi', 'scan_files/0/0_0.webp'])
    expect(entryNames).not.toContain('scan_files/1/0_0.webp')
    const completedChunks: Uint8Array[] = []
    await streamDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      pyramid.slice(0, 1),
      (chunk) => {
        completedChunks.push(chunk.slice())
      },
    )
    const partial = concatenate(chunks)
    const complete = concatenate(completedChunks)
    expect(partial.length).toBeLessThan(complete.length)
    expect(partial).toEqual(complete.subarray(0, partial.length))
  })

  test('aborts before start without delivering any entries', async () => {
    const controller = new AbortController()
    controller.abort()
    let chunks = 0
    let cleanup = 0
    await expect(
      streamDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          signal: controller.signal,
          onCleanup: () => {
            cleanup++
          },
        },
        pyramid,
        () => {
          chunks++
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(chunks).toBe(0)
    expect(cleanup).toBe(1)
  })

  test('does not clean up after successful completion', async () => {
    let cleanup = 0
    await streamDeepZoomZip(
      {
        name: 'scan',
        ...descriptorOptions,
        onCleanup: () => {
          cleanup++
        },
      },
      pyramid,
      () => {},
    )
    expect(cleanup).toBe(0)
  })

  test('cleans up exactly once on sink rejection', async () => {
    let cleanup = 0
    const failure = new Error('sink failed')
    await expect(
      streamDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          onCleanup: () => {
            cleanup++
          },
        },
        pyramid,
        () => {
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    expect(cleanup).toBe(1)
  })

  test('rejects unsafe paths and out-of-range tile coordinates', async () => {
    await expect(
      streamDeepZoomZip({ name: '../escape', ...descriptorOptions }, [], () => {}),
    ).rejects.toThrow(RangeError)
    await expect(
      streamDeepZoomZip({ name: 'scan', ...descriptorOptions, format: '../webp' }, [], () => {}),
    ).rejects.toThrow(RangeError)
    await expect(
      streamDeepZoomZip(
        { name: 'scan', ...descriptorOptions },
        [{ level: 1, col: 2, row: 0, bytes: Uint8Array.from([1]) }],
        () => {},
      ),
    ).rejects.toThrow(RangeError)
  })
})
