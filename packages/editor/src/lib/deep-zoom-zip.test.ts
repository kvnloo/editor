import { describe, expect, test } from 'bun:test'
import {
  type DeepZoomZipArtifactHost,
  type DeepZoomZipTile,
  createBrowserDeepZoomZipArtifactHost,
  persistDeepZoomZip,
  streamDeepZoomZip,
} from '@pascal-app/editor/deep-zoom-zip'
import {
  deepZoomDescriptor,
  deepZoomTilesUrl,
  deepZoomTileUrl,
  parseDeepZoomDescriptor,
} from '@pascal-app/viewer/capture'
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

  test('resolves uppercase format to the emitted archive tile path', async () => {
    const chunks: Uint8Array[] = []
    await streamDeepZoomZip(
      { name: 'scan', width: 1, height: 1, tileSize: 1, overlap: 0, format: 'WEBP' },
      [{ level: 0, col: 0, row: 0, bytes: Uint8Array.of(1) }],
      (chunk) => {
        chunks.push(chunk.slice())
      },
    )

    const entries = unzipSync(concatenate(chunks))
    expect(Object.keys(entries)).toEqual(['scan.dzi', 'scan_files/0/0_0.webp'])
    const descriptor = strFromU8(entries['scan.dzi']!)
    expect(descriptor).toContain('Format="webp"')
    const parsed = parseDeepZoomDescriptor(descriptor)
    expect(parsed.format).toBe('webp')
    const path = deepZoomTileUrl(deepZoomTilesUrl('scan.dzi'), 0, 0, 0, parsed.format)
    expect(entries[path]).toEqual(Uint8Array.of(1))
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
      for (const tile of pyramid.slice(2)) yield tile
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
      'scan_files/1/1_0.webp',
      'scan_files/1/0_1.webp',
      'scan_files/1/1_1.webp',
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
      pyramid,
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

  test('refuses missing and duplicate tiles before publishing', async () => {
    const host = await createBrowserDeepZoomZipArtifactHost({ directory: null })

    for (const tiles of [[], pyramid.slice(0, -1)]) {
      await expect(
        persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, tiles, host),
      ).rejects.toThrow('incomplete DeepZoom pyramid')
      expect(await host.getPublished('scan.zip')).toBeUndefined()
    }

    await expect(
      persistDeepZoomZip(
        { name: 'scan', ...descriptorOptions },
        [...pyramid, pyramid[0]!],
        host,
      ),
    ).rejects.toThrow('duplicate DeepZoom tile coordinates')
    expect(await host.getPublished('scan.zip')).toBeUndefined()

    await persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host)
    const published = await host.getPublished('scan.zip')
    expect(published).toBeDefined()
    const entries = unzipSync(new Uint8Array(await published!.arrayBuffer()))
    expect(Object.keys(entries)).toHaveLength(6)
    expect(entries['scan_files/1/1_1.webp']).toEqual(pyramid[4]!.bytes)
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
  const previousByName = new Map<string, Promise<void>>()
  let stageCreations = 0
  let secondStageCreated!: () => void
  const secondStageStarted = new Promise<void>((resolve) => {
    secondStageCreated = resolve
  })
  let destinationLookup:
    | { filename: string; entered: () => void; gate: Promise<void> }
    | undefined
  const lockRequests: { signal?: AbortSignal }[] = []
  let secondRequested!: () => void
  const secondLockRequested = new Promise<void>((resolve) => {
    secondRequested = resolve
  })
  const lockManager = {
    request(
      name: string,
      options: { mode: 'exclusive'; signal?: AbortSignal },
      callback: () => Promise<void>,
    ) {
      lockRequests.push({ signal: options.signal })
      if (lockRequests.length === 2) secondRequested()
      let queued = true
      const pending = (previousByName.get(name) ?? Promise.resolve()).then(async () => {
        queued = false
        options.signal?.throwIfAborted()
        await callback()
      })
      previousByName.set(name, pending.then(() => undefined, () => undefined))
      if (!options.signal) return pending
      const signal = options.signal
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          if (queued) {
            reject(signal.reason ?? new DOMException('Lock request aborted', 'AbortError'))
          }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
        void pending.then(
          () => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          },
          (error) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          },
        )
      })
    },
  }

  const stagingDirectory = {
    async *entries() {
      for (const [name, entry] of staged) {
        yield [name, entry.handle] as [string, FileSystemFileHandle]
      }
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      let entry = staged.get(name)
      if (!entry && options?.create) {
        entry = { bytes: new Uint8Array(0), handle: {} as FileSystemFileHandle }
        const stagedEntry = entry
        const handle = {
          kind: 'file',
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
        stageCreations++
        if (stageCreations === 2) secondStageCreated()
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
      if (destinationLookup?.filename === name) {
        const held = destinationLookup
        destinationLookup = undefined
        held.entered()
        await held.gate
      }
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
    lockManager,
    lockRequests,
    secondLockRequested,
    secondStageStarted,
    pauseNextDestinationLookup(filename: string) {
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      destinationLookup = { filename, entered, gate }
      return { started, release }
    },
    staged,
    visible,
    events,
    addOrphan(name: string) {
      staged.set(name, {
        bytes: Uint8Array.of(99),
        handle: { kind: 'file' } as FileSystemFileHandle,
      })
    },
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
      lockManager: filesystem.lockManager,
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
      lockManager: filesystem.lockManager,
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

  test('refuses a collision without overwriting an existing Chromium OPFS ZIP', async () => {
    const filesystem = createOpfsFixture()
    const host = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    await persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host)
    const first = filesystem.visible.get('scan.zip')!.handle
    const bytes = new Uint8Array(await (await host.getPublished('scan.zip'))!.arrayBuffer())

    await expect(
      persistDeepZoomZip({ name: 'scan', ...descriptorOptions }, pyramid, host),
    ).rejects.toThrow('already exists')

    expect(filesystem.visible.get('scan.zip')!.handle).toBe(first)
    expect(new Uint8Array(await (await host.getPublished('scan.zip'))!.arrayBuffer())).toEqual(bytes)
    expect(filesystem.counts()).toEqual({ publicRemovals: 0, stageRemovals: 1 })
    expect(filesystem.staged.size).toBe(0)
  })

  test('holds a cross-tab stage lease until publication or rollback', async () => {
    const filesystem = createOpfsFixture()
    const first = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const second = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const live = await first.stage()
    let entered = false
    const waiting = second.stage().then((stage) => {
      entered = true
      return stage
    })
    await Promise.resolve()
    expect(entered).toBe(false)
    await live.discard()
    const next = await waiting
    expect(entered).toBe(true)
    await next.discard()
    expect(filesystem.staged.size).toBe(0)
  })

  test('cancels a queued publisher before it acquires the OPFS lease', async () => {
    const filesystem = createOpfsFixture()
    const first = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const controller = new AbortController()
    const second = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
      signal: controller.signal,
    })
    let startedWriting!: () => void
    const writing = new Promise<void>((resolve) => {
      startedWriting = resolve
    })
    let releaseTiles!: () => void
    const tileGate = new Promise<void>((resolve) => {
      releaseTiles = resolve
    })
    async function* heldTiles(): AsyncGenerator<DeepZoomZipTile> {
      startedWriting()
      await tileGate
      for (const tile of pyramid) yield tile
    }
    const firstPublish = persistDeepZoomZip(
      { name: 'first', ...descriptorOptions },
      heldTiles(),
      first,
    )
    await writing
    const waiting = persistDeepZoomZip(
      { name: 'second', ...descriptorOptions, signal: controller.signal },
      pyramid,
      second,
    )
    try {
      await filesystem.secondLockRequested
      expect(filesystem.lockRequests[1]?.signal).toBe(controller.signal)
      controller.abort()
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      expect(filesystem.staged.size).toBe(1)
      expect(filesystem.visible.size).toBe(0)
    } finally {
      controller.abort()
      releaseTiles()
      await firstPublish
      await waiting.catch(() => undefined)
    }
    expect([...filesystem.visible.keys()]).toEqual(['first.zip'])
    expect(filesystem.staged.size).toBe(0)
    expect(await second.getPublished('second.zip')).toBeUndefined()
  })

  test('serializes competing same-name publications across destination lookup and move', async () => {
    const filesystem = createOpfsFixture()
    const first = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const second = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const winningChunks: Uint8Array[] = []
    const winningHost: DeepZoomZipArtifactHost = {
      async stage() {
        const temporary = await first.stage()
        return {
          ...temporary,
          async write(chunk) {
            winningChunks.push(new Uint8Array(chunk))
            await temporary.write(chunk)
          },
        }
      },
    }
    const lookup = filesystem.pauseNextDestinationLookup('scan.zip')
    const winningPublish = persistDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      pyramid,
      winningHost,
    )
    await lookup.started

    const challengerTiles = pyramid.map((tile, index) =>
      index === 0 ? { ...tile, bytes: Uint8Array.of(88) } : tile,
    )
    const losingPublish = persistDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      challengerTiles,
      second,
    )
    const losingResult = losingPublish.then(
      () => ({ status: 'published' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    try {
      const competingStage = await Promise.race([
        filesystem.secondLockRequested.then(() => 'queued' as const),
        filesystem.secondStageStarted.then(() => 'overlap' as const),
      ])
      expect(competingStage).toBe('queued')
      expect(filesystem.staged.size).toBe(1)
      expect(filesystem.visible.size).toBe(0)
    } finally {
      lookup.release()
    }

    await winningPublish
    expect(await losingResult).toMatchObject({
      status: 'rejected',
      error: expect.objectContaining({ message: 'ZIP artifact already exists: scan.zip' }),
    })
    expect([...filesystem.visible.keys()]).toEqual(['scan.zip'])
    const published = await first.getPublished('scan.zip')
    expect(published).toBeDefined()
    const bytes = new Uint8Array(await published!.arrayBuffer())
    expect(bytes).toEqual(concatenate(winningChunks))
    const entries = unzipSync(bytes)
    expect(entries['scan_files/0/0_0.webp']).toEqual(pyramid[0]!.bytes)
    expect(entries['scan_files/0/0_0.webp']).not.toEqual(challengerTiles[0]!.bytes)
    expect(filesystem.events.filter((event) => event === 'move')).toHaveLength(1)
    expect(filesystem.counts()).toEqual({ publicRemovals: 0, stageRemovals: 1 })
    expect([...filesystem.staged.keys()].filter((name) => name.endsWith('.part'))).toEqual([])
    expect(filesystem.staged.size).toBe(0)
  })

  test('preserves a lock-less legacy part during recovery', async () => {
    const filesystem = createOpfsFixture()
    const legacy = 'dzi-00000000-0000-4000-8000-000000000000.part'
    const locked = 'dzi-locked-11111111-1111-4111-8111-111111111111.part'
    filesystem.addOrphan(legacy)
    filesystem.addOrphan(locked)
    const host = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    expect(await host.recoverAbandonedStages()).toBe(1)
    expect([...filesystem.staged.keys()]).toEqual([legacy])
    const active = await host.stage()
    expect(filesystem.staged.has(legacy)).toBe(true)
    await active.discard()
    expect([...filesystem.staged.keys()]).toEqual([legacy])
    expect(filesystem.counts().publicRemovals).toBe(0)
  })

  test('reclaims abandoned parts after reload and preserves unrelated files', async () => {
    const filesystem = createOpfsFixture()
    const abandoned = 'dzi-locked-00000000-0000-4000-8000-000000000000.part'
    filesystem.addOrphan(abandoned)
    filesystem.addOrphan('keep-me.txt')
    const host = await createBrowserDeepZoomZipArtifactHost({
      directory: filesystem.directory,
      lockManager: filesystem.lockManager,
      requireStagedFile: true,
    })
    const live = await host.stage()
    expect(filesystem.staged.has(abandoned)).toBe(false)
    expect(filesystem.staged.has('keep-me.txt')).toBe(true)
    await live.discard()
    filesystem.addOrphan(abandoned)
    expect(await host.recoverAbandonedStages()).toBe(1)
    expect(filesystem.staged.has(abandoned)).toBe(false)
    expect(filesystem.staged.has('keep-me.txt')).toBe(true)
    expect(filesystem.counts().publicRemovals).toBe(0)
  })
})
