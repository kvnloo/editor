import { describe, expect, test } from 'bun:test'
import {
  deepZoomTiles,
  planGigapixelCapture,
  planGigapixelPyramid,
} from '@pascal-app/viewer/capture'

const large = {
  width: 32_768,
  height: 18_432,
  passEdge: 4096,
  tileSize: 512,
  overlap: 1,
  renderOverlap: 96,
}

const key = (col: number, row: number): string => col + ':' + row

describe('gigapixel capture plan', () => {
  test('emits every max-level tile once, immediately after its last source fragment', () => {
    const plan = planGigapixelCapture(large)
    const dziTiles = deepZoomTiles(large.width, large.height, large.tileSize, large.overlap)
    const expected = new Map(dziTiles.map((tile) => [key(tile.col, tile.row), tile]))
    const readPixels = new Map<string, number>()
    const emitted = new Set<string>()

    expect(plan.passes).toHaveLength(45)
    expect(dziTiles).toHaveLength(2304)

    for (const pass of plan.passes) {
      for (const fragment of pass.fragments) {
        const id = key(fragment.col, fragment.row)
        const dzi = expected.get(id)
        expect(dzi).toBeDefined()
        if (!dzi) throw new Error('unknown DZI tile')

        expect(fragment.x).toBeGreaterThanOrEqual(dzi.x)
        expect(fragment.y).toBeGreaterThanOrEqual(dzi.y)
        expect(fragment.x + fragment.w).toBeLessThanOrEqual(dzi.x + dzi.w)
        expect(fragment.y + fragment.h).toBeLessThanOrEqual(dzi.y + dzi.h)
        expect(fragment.x).toBeGreaterThanOrEqual(pass.render.inner.x)
        expect(fragment.y).toBeGreaterThanOrEqual(pass.render.inner.y)
        expect(fragment.x + fragment.w).toBeLessThanOrEqual(
          pass.render.inner.x + pass.render.inner.w,
        )
        expect(fragment.y + fragment.h).toBeLessThanOrEqual(
          pass.render.inner.y + pass.render.inner.h,
        )
        readPixels.set(id, (readPixels.get(id) ?? 0) + fragment.w * fragment.h)
      }

      for (const tile of pass.emittedTiles) {
        const id = key(tile.col, tile.row)
        expect(expected.get(id)).toEqual(tile)
        expect(emitted.has(id)).toBe(false)
        expect(readPixels.get(id)).toBe(tile.w * tile.h)
        emitted.add(id)
      }

      for (const [id, pixels] of readPixels) {
        const tile = expected.get(id)!
        if (pixels === tile.w * tile.h) expect(emitted.has(id)).toBe(true)
        else expect(emitted.has(id)).toBe(false)
      }
    }

    expect(emitted.size).toBe(expected.size)
    for (const [id, tile] of expected) {
      expect(readPixels.get(id)).toBe(tile.w * tile.h)
    }
    expect(plan.passes.at(-1)!.retainedPixelsAfter).toBe(0)
  })

  test('indexes strict child intersections across non-overlap and shared overlap edges', () => {
    const separate = planGigapixelPyramid(8, 4, 2, 0)
    const shared = planGigapixelPyramid(8, 4, 2, 1)
    const separateTop = separate.dependencies[2]!
    const sharedTop = shared.dependencies[2]!
    expect([...separateTop.parents.keys()]).toEqual(['0_0', '1_0'])
    expect(separateTop.parents.get('0_0')?.children).toEqual(['0_0', '1_0', '0_1', '1_1'])
    expect(separateTop.parents.get('1_0')?.children).toEqual(['2_0', '3_0', '2_1', '3_1'])
    expect(separateTop.byChild.get('1_0')).toEqual(['0_0'])
    expect(separateTop.byChild.get('2_0')).toEqual(['1_0'])

    const allChildren = ['0_0', '1_0', '2_0', '3_0', '0_1', '1_1', '2_1', '3_1']
    expect([...sharedTop.parents.values()].map(({ children }) => children)).toEqual([
      allChildren,
      allChildren,
    ])
    expect(sharedTop.byChild.get('0_0')).toEqual(['0_0', '1_0'])
    expect(sharedTop.byChild.get('3_1')).toEqual(['0_0', '1_0'])

    const plan = planGigapixelCapture({
      width: 8,
      height: 4,
      passEdge: 8,
      tileSize: 2,
      overlap: 1,
      renderOverlap: 0,
    })
    expect(plan.pyramid.dependencies[2]!.parents.get('1_0')?.children).toEqual(allChildren)
  })

  test('bounds readbacks, copied fragments and pyramid buffers below five full passes', () => {
    const plan = planGigapixelCapture(large)
    // Loose budget for readback + ready copies + unfinished seams + pyramid
    // children/assembly, still far smaller than a full-image buffer.
    const conservativeBound = 5 * 4096 ** 2
    expect(conservativeBound).toBe(83_886_080)
    expect(plan.peakResidentPixels).toBeLessThan(conservativeBound)
    expect(plan.peakResidentPixels).toBeGreaterThan(2 * 4096 ** 2)
  })

  test('one render pass emits all DZI tiles without keeping fragments', () => {
    const options = { ...large, width: 1920, height: 1080 }
    const plan = planGigapixelCapture(options)
    expect(plan.passes).toHaveLength(1)
    expect(plan.passes[0]!.render.inner).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(plan.passes[0]!.emittedTiles).toEqual(deepZoomTiles(1920, 1080, 512, 1))
    expect(plan.passes[0]!.retainedPixelsAfter).toBe(0)
    // 1920*1080 readback + (1926*1084) overlap-expanded ready copies.
    expect(plan.peakResidentPixels).toBe(4_161_384)
  })

  test('a DZI seam tile waits for the second render pass', () => {
    const plan = planGigapixelCapture({
      width: 1024,
      height: 512,
      passEdge: 600,
      tileSize: 512,
      overlap: 1,
      renderOverlap: 0,
    })
    expect(plan.passes).toHaveLength(2)
    expect(plan.passes[0]!.emittedTiles).toEqual([])
    expect(plan.passes[1]!.emittedTiles.map(({ col, row }) => [col, row])).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(plan.passes[1]!.retainedPixelsAfter).toBe(0)
  })

  test('rejects unsafe or non-progressing render grids and invalid DZI options', () => {
    expect(() => planGigapixelCapture({ ...large, width: 0 })).toThrow(RangeError)
    expect(() => planGigapixelCapture({ ...large, passEdge: 192 })).toThrow(RangeError)
    expect(() => planGigapixelCapture({ ...large, renderOverlap: -1 })).toThrow(RangeError)
    expect(() => planGigapixelCapture({ ...large, tileSize: 0 })).toThrow(RangeError)
    expect(() => planGigapixelCapture({ ...large, overlap: 513 })).toThrow(RangeError)
    expect(() =>
      planGigapixelCapture({ ...large, width: Number.MAX_SAFE_INTEGER, height: 2 }),
    ).toThrow(RangeError)
  })
})
