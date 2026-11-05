import { describe, expect, test } from 'bun:test'
import { streamGigapixelCapture } from '@pascal-app/editor/gigapixel-capture'
import { deepZoomDescriptor, planGigapixelCapture } from '@pascal-app/viewer/capture'
import { strFromU8, unzipSync } from 'fflate'

const options = {
  name: 'capture',
  width: 2050,
  height: 1030,
  passEdge: 1024,
  tileSize: 512,
  overlap: 1,
  renderOverlap: 96,
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

describe('streamGigapixelCapture', () => {
  test('streams every DZI level, preserves a two-pass seam, and respects the pass bound', async () => {
    const chunks: Uint8Array[] = []
    const captured = await streamGigapixelCapture(
      options,
      (pass) => {
        const pixels = new Uint8ClampedArray(pass.w * pass.h * 4)
        for (let y = 0; y < pass.h; y++) {
          for (let x = 0; x < pass.w; x++) {
            const gx = pass.x + x
            const gy = pass.y + y
            const at = (y * pass.w + x) * 4
            pixels[at] = gx % 256
            pixels[at + 1] = gy % 256
            pixels[at + 2] = (gx + gy) % 256
            pixels[at + 3] = 255
          }
        }
        return pixels
      },
      (rgba) => new Uint8Array(rgba),
      (chunk) => chunks.push(chunk.slice()),
    )

    const files = unzipSync(concatenate(chunks))
    expect(strFromU8(files['capture.dzi']!)).toBe(
      deepZoomDescriptor({
        width: 2050,
        height: 1030,
        tileSize: 512,
        overlap: 1,
        format: 'webp',
      }),
    )

    // Level 12: 5 x 3; level 11: 3 x 2; level 10: 2 x 1;
    // levels 0..9 each contain one tile: 15 + 6 + 2 + 10 = 33.
    const counts = Array.from({ length: 13 }, (_, level) =>
      Object.keys(files).filter((path) => path.startsWith('capture_files/' + level + '/')).length,
    )
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 6, 15])
    expect(Object.keys(files)).toHaveLength(34)

    // The first pass contributes x < 683; the second supplies x >= 683.
    // The max-level tile at col 1 begins at x=511 and is 514 pixels wide.
    const seam = files['capture_files/12/1_0.webp']!
    expect(seam.length).toBe(514 * 513 * 4)
    for (const x of [682, 683, 1023]) {
      const y = 200
      const at = (y * 514 + x - 511) * 4
      expect(Array.from(seam.subarray(at, at + 4))).toEqual([
        x % 256,
        y % 256,
        (x + y) % 256,
        255,
      ])
    }

    // Pixel (200,100) at level 11 averages source (400..401,200..201).
    const half = files['capture_files/11/0_0.webp']!
    expect(
      Array.from(half.subarray((100 * 513 + 200) * 4, (100 * 513 + 201) * 4)),
    ).toEqual([145, 201, 89, 255])

    const plan = planGigapixelCapture(options)
    expect(captured.passes).toBe(6)
    expect(captured.tilesWritten).toBe(33)
    expect(captured.peakResidentPixels).toBeGreaterThan(0)
    expect(captured.peakResidentPixels).toBeLessThanOrEqual(plan.peakResidentPixels)
    expect(captured.planPeakResidentPixels).toBe(plan.peakResidentPixels)
  })

  test('rejects an incorrect render readback instead of writing a partial success', async () => {
    await expect(
      streamGigapixelCapture(
        options,
        () => new Uint8ClampedArray(0),
        (rgba) => new Uint8Array(rgba),
        () => {},
      ),
    ).rejects.toThrow('Render pass must return tightly packed RGBA pixels')
  })
})
