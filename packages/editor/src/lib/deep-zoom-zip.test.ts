import { describe, expect, test } from 'bun:test'
import { streamDeepZoomZip, type DeepZoomZipTile } from '@pascal-app/editor/deep-zoom-zip'
import { deepZoomDescriptor } from '@pascal-app/viewer/capture'
import { strFromU8, unzipSync } from 'fflate'
import { createInMemoryGigapixelArtifactSink } from '@pascal-app/editor/gigapixel-artifact-sink'

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
  test('a fake tile source commits one descriptor plus N ZIP tiles', async () => {
    const sink = createInMemoryGigapixelArtifactSink()
    async function* source(): AsyncGenerator<DeepZoomZipTile> {
      for (const tile of pyramid) {
        yield tile
        await sink.write({ kind: 'tile' })
      }
    }
    await streamDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      source(),
      (chunk) => sink.write({ kind: 'zip-chunk', bytes: chunk }),
    )
    const receipt = await sink.finish()
    const archive = new Uint8Array(await sink.blob().arrayBuffer())
    const entries = unzipSync(archive)
    expect(receipt.bytes).toBe(archive.length)
    expect(receipt.tileCount).toBe(pyramid.length)
    expect(Object.keys(entries)).toHaveLength(pyramid.length + 1)
    expect(strFromU8(entries['scan.dzi']!)).toBe(deepZoomDescriptor(descriptorOptions))
    for (const tile of pyramid) {
      expect(entries['scan_files/' + tile.level + '/' + tile.col + '_' + tile.row + '.webp']).toEqual(
        tile.bytes,
      )
    }
  })

  test('awaits a chunk sink before pulling the next fake tile', async () => {
    let written = false
    async function* source(): AsyncGenerator<DeepZoomZipTile> {
      yield pyramid[0]!
      expect(written).toBe(true)
      yield pyramid[1]!
    }
    await streamDeepZoomZip(
      { name: 'scan', ...descriptorOptions },
      source(),
      async () => {
        await Promise.resolve()
        written = true
      },
    )
  })

})
