import { describe, expect, test } from 'bun:test'
import { streamDeepZoomZip, type DeepZoomZipTile } from '@pascal-app/editor/deep-zoom-zip'
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
