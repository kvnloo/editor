import { describe, expect, test } from 'bun:test'
import {
  type DeepZoomZipArtifactHost,
  type DeepZoomZipTile,
  createBrowserDeepZoomZipArtifactHost,
  persistDeepZoomZip,
  streamDeepZoomZip,
} from '@pascal-app/editor/deep-zoom-zip'
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

function createTransactionalHost(failOnWrite?: { at: number; error: Error }) {
  const visible = new Map<string, Uint8Array>()
  const staged = new Set<Uint8Array[]>()
  const events: string[] = []
  let writes = 0
  const host: DeepZoomZipArtifactHost = {
    stage() {
      const chunks: Uint8Array[] = []
      staged.add(chunks)
      events.push('stage')
      return {
        write(chunk) {
          expect(visible.size).toBe(0)
          chunks.push(chunk.slice())
          writes++
          events.push('write')
          if (failOnWrite?.at === writes) {
            return Promise.reject(failOnWrite.error)
          }
        },
        publish(filename) {
          const bytes = concatenate(chunks)
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          // The end-of-central-directory record must already be present before publication.
          expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
          expect(view.getUint16(bytes.length - 12, true)).toBe(6)
          visible.set(filename, bytes)
          staged.delete(chunks)
          events.push('publish')
        },
        discard() {
          staged.delete(chunks)
          events.push('discard')
        },
      }
    },
  }
  return { host, visible, staged, events, writeCount: () => writes }
}

describe('persistDeepZoomZip', () => {
  test('publishes only a complete central-directory ZIP', async () => {
    const { host, visible, staged, events } = createTransactionalHost()

    await persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host)

    expect([...visible.keys()]).toEqual(['scan.zip'])
    expect(staged.size).toBe(0)
    expect(events.at(-1)).toBe('publish')
    expect(events).not.toContain('discard')

    const entries = unzipSync(visible.get('scan.zip')!)
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

  test('aborts after a staged tile without exposing a partial archive', async () => {
    const controller = new AbortController()
    const { host, visible, staged, events, writeCount } = createTransactionalHost()
    let cleanup = 0
    let delivered = 0

    async function* tiles(): AsyncGenerator<DeepZoomZipTile> {
      delivered++
      yield pyramid[0]!
      controller.abort()
      delivered++
      yield pyramid[1]!
    }

    await expect(
      persistDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          signal: controller.signal,
          onCleanup: () => {
            cleanup++
          },
        },
        tiles(),
        host,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(delivered).toBe(2)
    expect(writeCount()).toBeGreaterThan(0)
    expect(visible.size).toBe(0)
    expect(staged.size).toBe(0)
    expect(events.filter((event) => event === 'discard')).toHaveLength(1)
    expect(events).not.toContain('publish')
    expect(cleanup).toBe(1)
  })

  test('rejects an async staged-writer error and discards all unpublished bytes', async () => {
    const failure = new Error('temporary ZIP writer failed')
    const { host, visible, staged, events, writeCount } = createTransactionalHost({
      at: 2,
      error: failure,
    })
    let cleanup = 0

    await expect(
      persistDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          onCleanup: () => {
            cleanup++
          },
        },
        pyramid,
        host,
      ),
    ).rejects.toBe(failure)

    expect(writeCount()).toBe(2)
    expect(visible.size).toBe(0)
    expect(staged.size).toBe(0)
    expect(events.filter((event) => event === 'discard')).toHaveLength(1)
    expect(events).not.toContain('publish')
    expect(cleanup).toBe(1)
  })
})

function createOpfsFixture(moveFailure?: Error) {
  interface Entry {
    bytes: Uint8Array
    handle: FileSystemFileHandle
  }

  const staged = new Map<string, Entry>()
  const visible = new Map<string, Entry>()
  const events: string[] = []
  let publicRemovals = 0
  let stageRemovals = 0
  const notFound = () => ({ name: 'NotFoundError' })

  const stagingDirectory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      let entry = staged.get(name)
      if (!entry && options?.create) {
        entry = { bytes: new Uint8Array(0), handle: {} as FileSystemFileHandle }
        const stagedEntry = entry
        const handle = {
          async createWritable() {
            const parts: Uint8Array[] = []
            return {
              async write(chunk: Uint8Array) {
                parts.push(new Uint8Array(chunk))
                events.push('write')
              },
              async close() {
                stagedEntry.bytes = concatenate(parts)
                events.push('close')
              },
              async abort() {
                events.push('abort')
              },
            }
          },
          async move(_directory: FileSystemDirectoryHandle, filename: string) {
            // A publish may fail after the last ZIP byte was drained and after a move occurred.
            const bytes = stagedEntry.bytes
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
            expect(view.getUint16(bytes.length - 12, true)).toBe(6)
            events.push('move')
            staged.delete(name)
            visible.set(filename, stagedEntry)
            if (moveFailure) throw moveFailure
          },
          async isSameEntry(other: FileSystemHandle) {
            return other === handle
          },
          async getFile() {
            return new Blob([new Uint8Array(stagedEntry.bytes)], { type: 'application/zip' })
          },
        } as unknown as FileSystemFileHandle
        stagedEntry.handle = handle
        staged.set(name, stagedEntry)
      }
      if (!entry) throw notFound()
      return entry.handle
    },
    async removeEntry(name: string) {
      if (!staged.delete(name)) throw notFound()
      stageRemovals++
      events.push('remove-stage')
    },
  }

  const directory = {
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      expect(name).toBe('.deep-zoom-zip-staging')
      expect(options?.create).toBe(true)
      return stagingDirectory
    },
    async getFileHandle(name: string) {
      const entry = visible.get(name)
      if (!entry) throw notFound()
      return entry.handle
    },
    async removeEntry(name: string) {
      if (!visible.delete(name)) throw notFound()
      publicRemovals++
      events.push('remove-public')
    },
  } as unknown as FileSystemDirectoryHandle

  return {
    directory,
    staged,
    visible,
    events,
    counts: () => ({ publicRemovals, stageRemovals }),
  }
}

describe('createBrowserDeepZoomZipArtifactHost', () => {
  test('falls back to a readable Blob without a persistent directory', async () => {
    const host = await createBrowserDeepZoomZipArtifactHost({ directory: null })
    expect(await host.getPublished('scan.zip')).toBeUndefined()

    await persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host)

    const blob = await host.getPublished('scan.zip')
    expect(blob?.type).toBe('application/zip')
    const archive = new Uint8Array(await blob!.arrayBuffer())
    expect(Object.keys(unzipSync(archive))).toHaveLength(6)
    expect(await host.getPublished('other.zip')).toBeUndefined()
  })

  test('publishes a finalized ZIP by moving a private OPFS staging handle', async () => {
    const filesystem = createOpfsFixture()
    const host = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
    })

    await persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host)

    expect([...filesystem.visible.keys()]).toEqual(['scan.zip'])
    expect(filesystem.staged.size).toBe(0)
    expect(filesystem.events.indexOf('close')).toBeLessThan(filesystem.events.indexOf('move'))
    expect(filesystem.counts()).toEqual({ publicRemovals: 0, stageRemovals: 0 })
    const blob = await host.getPublished('scan.zip')
    expect(Object.keys(unzipSync(new Uint8Array(await blob!.arrayBuffer())))).toHaveLength(6)
  })

  test('rolls back a rejected publish after final ZIP drain and preserves the error', async () => {
    const failure = new Error('atomic move reported a failure')
    const filesystem = createOpfsFixture(failure)
    const host = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
    })
    const stage = host.stage.bind(host)
    let discards = 0
    let cleanup = 0
    const observedHost: DeepZoomZipArtifactHost = {
      async stage() {
        const temporary = await stage()
        return {
          ...temporary,
          async discard() {
            discards++
            await temporary.discard()
          },
        }
      },
    }

    await expect(
      persistDeepZoomZip(
        {
          name: 'scan',
          ...descriptorOptions,
          onCleanup: () => {
            cleanup++
          },
        },
        pyramid,
        observedHost,
      ),
    ).rejects.toBe(failure)

    expect(filesystem.events.indexOf('close')).toBeLessThan(filesystem.events.indexOf('move'))
    expect(filesystem.events).toContain('remove-public')
    expect(filesystem.visible.size).toBe(0)
    expect(filesystem.staged.size).toBe(0)
    expect(await host.getPublished('scan.zip')).toBeUndefined()
    expect(discards).toBe(1)
    expect(cleanup).toBe(1)
    expect(filesystem.counts()).toEqual({ publicRemovals: 1, stageRemovals: 0 })
  })
})
