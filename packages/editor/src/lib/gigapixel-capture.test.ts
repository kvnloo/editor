import { describe, expect, test } from 'bun:test'
import { streamGigapixelCapture } from '@pascal-app/editor/gigapixel-capture'
import {
  createInMemoryGigapixelArtifactSink,
  type GigapixelArtifactSink,
} from '@pascal-app/editor/gigapixel-artifact-sink'
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

describe('streamGigapixelCapture', () => {
  test('streams every DZI level, preserves a two-pass seam, and respects the pass bound', async () => {
    const sink = createInMemoryGigapixelArtifactSink()
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
      sink,
    )

    const files = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
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
    expect(captured.artifact.tileCount).toBe(33)
    expect(captured.artifact.bytes).toBe(sink.blob().size)
    expect(captured.artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
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
        createInMemoryGigapixelArtifactSink(),
      ),
    ).rejects.toThrow('Render pass must return tightly packed RGBA pixels')
  })
  function trackSink() {
    const memory = createInMemoryGigapixelArtifactSink()
    let aborts = 0
    let finishes = 0
    const sink: GigapixelArtifactSink = {
      write: (entry) => memory.write(entry),
      async finish() {
        finishes += 1
        return memory.finish()
      },
      async abort() {
        aborts += 1
        await memory.abort()
      },
    }
    return { sink, memory, aborts: () => aborts, finishes: () => finishes }
  }

  test('a tile-source failure aborts exactly once and never finishes the ZIP', async () => {
    const tracked = trackSink()
    let pass = 0
    await expect(
      streamGigapixelCapture(
        options,
        (render) => {
          if (pass++ === 2) throw new Error('tile source failed')
          return new Uint8ClampedArray(render.w * render.h * 4)
        },
        (rgba) => new Uint8Array(rgba),
        tracked.sink,
      ),
    ).rejects.toThrow('tile source failed')
    expect(pass).toBe(3)
    expect(tracked.aborts()).toBe(1)
    expect(tracked.finishes()).toBe(0)
    expect(() => tracked.memory.blob()).toThrow('has not been committed')
  })

  test('cancellation mid-stream aborts exactly once without a successful artifact', async () => {
    const controller = new AbortController()
    const tracked = trackSink()
    let pass = 0
    await expect(
      streamGigapixelCapture(
        { ...options, signal: controller.signal },
        (render) => {
          if (++pass === 2) controller.abort()
          return new Uint8ClampedArray(render.w * render.h * 4)
        },
        (rgba) => new Uint8Array(rgba),
        tracked.sink,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(pass).toBe(2)
    expect(tracked.aborts()).toBe(1)
    expect(tracked.finishes()).toBe(0)
    expect(() => tracked.memory.blob()).toThrow('has not been committed')
  })

})
