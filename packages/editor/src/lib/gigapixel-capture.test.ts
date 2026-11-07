import { describe, expect, test } from 'bun:test'
import {
  createInMemoryGigapixelArtifactSink,
  createStagedGigapixelArtifactSink,
  type GigapixelArtifactSink,
} from '@pascal-app/editor/gigapixel-artifact-sink'
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

describe('streamGigapixelCapture', () => {
  test('streams all DZI levels, preserves seams, and bounds readbacks', async () => {
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

  test('counts ready tile copies and pyramid assembly in its resident budget', async () => {
    const small = {
      name: 'small',
      width: 4,
      height: 4,
      passEdge: 4,
      tileSize: 2,
      overlap: 0,
      renderOverlap: 0,
    }
    const plan = planGigapixelCapture(small)
    expect(plan.passes).toHaveLength(1)
    expect(plan.passes[0]!.retainedPixelsAfter).toBe(0)
    // 16 readback + 16 ready copies = 32; after readback release:
    // 4 ready-copy pixels + 16 completed children + 16 parent source + 4 half = 40.
    expect(plan.peakResidentPixels).toBe(40)

    const sink = createInMemoryGigapixelArtifactSink()
    const actual = await streamGigapixelCapture(
      small,
      (render) => new Uint8ClampedArray(render.w * render.h * 4),
      (rgba) => new Uint8Array(rgba),
      sink,
    )
    expect(actual.passes).toBe(1)
    expect(actual.tilesWritten).toBe(6)
    expect(actual.peakResidentPixels).toBe(40)
    expect(actual.planPeakResidentPixels).toBe(plan.peakResidentPixels)
    const entries = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
    expect(Object.keys(entries)).toHaveLength(7)
  })

  test('shares overlapping parent inputs without changing pixels or resident peak', async () => {
    const shared = {
      name: 'shared',
      width: 8,
      height: 4,
      passEdge: 8,
      tileSize: 2,
      overlap: 1,
      renderOverlap: 0,
    }
    const plan = planGigapixelCapture(shared)
    const sink = createInMemoryGigapixelArtifactSink()
    const actual = await streamGigapixelCapture(
      shared,
      (pass) => {
        const rgba = new Uint8ClampedArray(pass.w * pass.h * 4)
        for (let y = 0; y < pass.h; y++) {
          for (let x = 0; x < pass.w; x++) {
            const at = (y * pass.w + x) * 4
            rgba[at] = (pass.x + x) * 10
            rgba[at + 1] = (pass.y + y) * 20
            rgba[at + 3] = 255
          }
        }
        return rgba
      },
      (rgba) => new Uint8Array(rgba),
      sink,
    )
    const entries = unzipSync(new Uint8Array(await sink.blob().arrayBuffer()))
    expect(actual.tilesWritten).toBe(12)
    expect(Object.keys(entries)).toHaveLength(13)
    expect(actual.peakResidentPixels).toBe(plan.peakResidentPixels)
    expect(actual.planPeakResidentPixels).toBe(plan.peakResidentPixels)

    const left = entries['shared_files/2/0_0.webp']!
    const right = entries['shared_files/2/1_0.webp']!
    expect(left).toHaveLength(3 * 2 * 4)
    expect(right).toHaveLength(3 * 2 * 4)
    // Both parents consume child pixels x=2..5; their overlapping outputs agree.
    expect(Array.from(left.subarray(4, 8))).toEqual([25, 10, 0, 255])
    expect(Array.from(right.subarray(0, 4))).toEqual([25, 10, 0, 255])
    expect(Array.from(left.subarray(8, 12))).toEqual([45, 10, 0, 255])
    expect(Array.from(right.subarray(4, 8))).toEqual([45, 10, 0, 255])
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

  test('publishes 34 staged ZIP entries after backpressure drains', async () => {
    const chunks: Uint8Array[] = []
    let published: Blob | undefined
    let renders = 0
    let publicationCount = 0
    let releaseWrite!: () => void
    let beginWrite!: () => void
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const writeStarted = new Promise<void>((resolve) => {
      beginWrite = resolve
    })
    const sink = await createStagedGigapixelArtifactSink(
      {
        stage: () => ({
          async write(chunk) {
            if (chunks.length === 0) {
              beginWrite()
              await blockedWrite
            }
            chunks.push(chunk.slice())
          },
          publish(filename) {
            expect(filename).toBe('capture.deepzoom.zip')
            publicationCount += 1
            published = new Blob(chunks, { type: 'application/zip' })
          },
          discard() {
            published = undefined
            chunks.length = 0
          },
        }),
      },
      'capture.deepzoom.zip',
    )

    const pending = streamGigapixelCapture(
      options,
      (pass) => {
        renders += 1
        return new Uint8ClampedArray(pass.w * pass.h * 4)
      },
      (rgba) => new Uint8Array(rgba),
      sink,
    )
    await writeStarted
    expect(renders).toBe(0)
    expect(publicationCount).toBe(0)
    releaseWrite()

    const stats = await pending
    expect(publicationCount).toBe(1)
    expect(stats.tilesWritten).toBe(33)
    expect(stats.artifact.tileCount).toBe(33)
    expect(stats.artifact.bytes).toBe(published!.size)
    expect(stats.peakResidentPixels).toBeLessThanOrEqual(stats.planPeakResidentPixels)
    const archive = unzipSync(new Uint8Array(await published!.arrayBuffer()))
    expect(Object.keys(archive)).toHaveLength(34)
    expect(strFromU8(archive['capture.dzi']!)).toBe(
      deepZoomDescriptor({
        width: 2050,
        height: 1030,
        tileSize: 512,
        overlap: 1,
        format: 'webp',
      }),
    )
    await sink.rollback()
    expect(published).toBeUndefined()
  })

  test('an aborted staged capture discards the partial archive and never publishes', async () => {
    let discarded = 0
    let published = 0
    const controller = new AbortController()
    const sink = await createStagedGigapixelArtifactSink(
      {
        stage: () => ({
          async write() {},
          async publish() {
            published += 1
          },
          async discard() {
            discarded += 1
          },
        }),
      },
      'capture.deepzoom.zip',
    )
    let passes = 0
    await expect(
      streamGigapixelCapture(
        { ...options, signal: controller.signal },
        (pass) => {
          if (++passes === 2) controller.abort()
          return new Uint8ClampedArray(pass.w * pass.h * 4)
        },
        (rgba) => new Uint8Array(rgba),
        sink,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(discarded).toBe(1)
    expect(published).toBe(0)
  })


  test('a project switch during the final readback cannot publish into its old destination', async () => {
    let activeProject = 'project-a'
    let captureVersion = 1
    const published = new Map<string, Blob>()
    const chunks: Uint8Array[] = []
    let readbacks = 0
    let releaseFinal!: () => void
    let announceFinal!: () => void
    const finalReadback = new Promise<void>((resolve) => {
      releaseFinal = resolve
    })
    const finalReadbackStarted = new Promise<void>((resolve) => {
      announceFinal = resolve
    })
    const sink = await createStagedGigapixelArtifactSink(
      {
        stage() {
          return {
            write(bytes) {
              chunks.push(bytes.slice())
            },
            publish(filename) {
              published.set(filename, new Blob(chunks, { type: 'application/zip' }))
            },
            discard() {
              chunks.length = 0
              published.clear()
            },
          }
        },
      },
      'capture.deepzoom.zip',
    )
    const pending = streamGigapixelCapture(
      {
        name: 'capture',
        width: 6,
        height: 2,
        passEdge: 4,
        tileSize: 1,
        overlap: 0,
        renderOverlap: 0,
        assertCanPublish: () => {
          if (activeProject !== 'project-a' || captureVersion !== 1) {
            throw new Error('The capture project is no longer current')
          }
        },
      },
      async (render) => {
        readbacks += 1
        if (readbacks === 2) {
          announceFinal()
          await finalReadback
        }
        return new Uint8ClampedArray(render.w * render.h * 4)
      },
      (rgba) => new Uint8Array(rgba),
      sink,
    )
    await finalReadbackStarted
    expect(readbacks).toBe(2)
    expect(chunks.length).toBeGreaterThan(0)
    expect(published.size).toBe(0)
    activeProject = 'project-b'
    captureVersion += 1
    releaseFinal()
    await expect(pending).rejects.toThrow('The capture project is no longer current')
    expect(published.size).toBe(0)
  })

})
