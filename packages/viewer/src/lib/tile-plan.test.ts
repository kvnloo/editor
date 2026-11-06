import { expect, test } from 'bun:test'
import { tileGrid } from '../index'

const PASS_EDGE = 4096
const OVERLAP = 96

for (const { width, height, cols, rows } of [
  { width: 8192, height: 8192, cols: 3, rows: 3 },
  { width: 10_000, height: 3001, cols: 3, rows: 1 },
  { width: 1920, height: 1080, cols: 1, rows: 1 },
  { width: 3209, height: 2588, cols: 1, rows: 1 },
  { width: 4423, height: 3567, cols: 2, rows: 1 },
]) {
  test(`${width}×${height}: inner coverage and clipped render tiles`, () => {
    const tiles = tileGrid(width, height, PASS_EDGE, OVERLAP)
    expect(tiles).toHaveLength(cols * rows)

    let coveredArea = 0
    for (const [index, tile] of tiles.entries()) {
      const { inner } = tile
      expect([tile.col, tile.row]).toEqual([index % cols, Math.floor(index / cols)])

      expect(inner.w).toBeGreaterThan(0)
      expect(inner.h).toBeGreaterThan(0)
      expect(inner.x).toBeGreaterThanOrEqual(0)
      expect(inner.y).toBeGreaterThanOrEqual(0)
      expect(inner.x + inner.w).toBeLessThanOrEqual(width)
      expect(inner.y + inner.h).toBeLessThanOrEqual(height)
      coveredArea += inner.w * inner.h

      expect(tile.x).toBeGreaterThanOrEqual(0)
      expect(tile.y).toBeGreaterThanOrEqual(0)
      expect(tile.x + tile.w).toBeLessThanOrEqual(width)
      expect(tile.y + tile.h).toBeLessThanOrEqual(height)
      expect(tile.w).toBeGreaterThan(0)
      expect(tile.h).toBeGreaterThan(0)
      expect(tile.w).toBeLessThanOrEqual(PASS_EDGE)
      expect(tile.h).toBeLessThanOrEqual(PASS_EDGE)
      expect(tile.x).toBeLessThanOrEqual(inner.x)
      expect(tile.y).toBeLessThanOrEqual(inner.y)
      expect(tile.x + tile.w).toBeGreaterThanOrEqual(inner.x + inner.w)
      expect(tile.y + tile.h).toBeGreaterThanOrEqual(inner.y + inner.h)

      if (inner.x === 0) expect(tile.x).toBe(0)
      if (inner.y === 0) expect(tile.y).toBe(0)
      if (inner.x + inner.w === width) expect(tile.x + tile.w).toBe(width)
      if (inner.y + inner.h === height) expect(tile.y + tile.h).toBe(height)

      for (const other of tiles.slice(index + 1)) {
        const sharedW = Math.max(
          0,
          Math.min(inner.x + inner.w, other.inner.x + other.inner.w) -
            Math.max(inner.x, other.inner.x),
        )
        const sharedH = Math.max(
          0,
          Math.min(inner.y + inner.h, other.inner.y + other.inner.h) -
            Math.max(inner.y, other.inner.y),
        )
        expect(sharedW * sharedH).toBe(0)
      }
    }
    expect(coveredArea).toBe(width * height)
  })
}

test('a single pass contributes and renders exactly the full picture', () => {
  expect(tileGrid(3209, 2588, PASS_EDGE, OVERLAP)).toEqual([
    { col: 0, row: 0, x: 0, y: 0, w: 3209, h: 2588, inner: { x: 0, y: 0, w: 3209, h: 2588 } },
  ])
})

test('both sides of a seam render neighbouring pixels', () => {
  const tiles = tileGrid(4423, 3567, PASS_EDGE, OVERLAP)
  expect(tiles).toHaveLength(2)
  const left = tiles[0]!
  const right = tiles[1]!
  expect(left.inner.x + left.inner.w).toBe(right.inner.x)
  expect(left.x + left.w - (left.inner.x + left.inner.w)).toBeGreaterThan(0)
  expect(right.inner.x - right.x).toBeGreaterThan(0)
})

test('the caller controls the overlap independently of the picture', () => {
  const tiles = tileGrid(4423, 3567, PASS_EDGE, 0)
  expect(tiles).toHaveLength(2)
  for (const tile of tiles) {
    expect({ x: tile.x, y: tile.y, w: tile.w, h: tile.h }).toEqual(tile.inner)
  }
})

for (const { input, args, reason } of [
  { input: 'zero width', args: [0, 8, 7, 3], reason: 'width' },
  { input: 'negative width', args: [-1, 8, 7, 3], reason: 'width' },
  { input: 'fractional width', args: [1.5, 8, 7, 3], reason: 'width' },
  { input: 'infinite width', args: [Infinity, 8, 7, 3], reason: 'width' },
  { input: 'unsafe integer width', args: [Number.MAX_SAFE_INTEGER + 1, 8, 7, 3], reason: 'width' },
  { input: 'zero height', args: [8, 0, 7, 3], reason: 'height' },
  { input: 'negative height', args: [8, -1, 7, 3], reason: 'height' },
  { input: 'fractional height', args: [8, 2.5, 7, 3], reason: 'height' },
  { input: 'NaN height', args: [8, NaN, 7, 3], reason: 'height' },
  { input: 'zero pass edge', args: [8, 8, 0, 0], reason: 'passEdge' },
  { input: 'negative pass edge', args: [8, 8, -7, 0], reason: 'passEdge' },
  { input: 'fractional pass edge', args: [8, 8, 7.5, 0], reason: 'passEdge' },
  { input: 'infinite pass edge', args: [8, 8, Infinity, 0], reason: 'passEdge' },
  { input: 'negative overlap', args: [8, 8, 7, -1], reason: 'overlap' },
  { input: 'NaN overlap', args: [8, 8, 7, NaN], reason: 'overlap' },
  { input: 'infinite overlap', args: [8, 8, 7, Infinity], reason: 'overlap' },
  { input: 'zero interior', args: [8, 8, 8, 4], reason: 'overlap' },
  { input: 'negative interior', args: [8, 8, 7, 4], reason: 'overlap' },
] as const) {
  test(`rejects ${input} with a RangeError`, () => {
    expect(() => tileGrid(...args)).toThrow(RangeError)
    expect(() => tileGrid(...args)).toThrow(reason)
  })
}

test('an interior of exactly one pixel remains tileable', () => {
  const tiles = tileGrid(8, 6, 7, 3)
  expect(tiles).toHaveLength(8)
  expect(tiles.map(({ x, w }) => [x, w])).toEqual([
    [0, 4],
    [0, 5],
    [0, 6],
    [0, 7],
    [1, 7],
    [2, 6],
    [3, 5],
    [4, 4],
  ])
  for (const [column, tile] of tiles.entries()) {
    expect([tile.col, tile.row]).toEqual([column, 0])
    expect(tile.inner).toEqual({ x: column, y: 0, w: 1, h: 6 })
    expect(tile.h).toBe(6)
  }
})

test('the existing two-pass fixture retains its exact serialized geometry', () => {
  const expectedTiles = [
    '{"col":0,"row":0,"x":0,"y":0,"w":2308,"h":3567,"inner":{"x":0,"y":0,"w":2212,"h":3567}}',
    '{"col":1,"row":0,"x":2116,"y":0,"w":2307,"h":3567,"inner":{"x":2212,"y":0,"w":2211,"h":3567}}',
  ]
  expect(JSON.stringify(tileGrid(4423, 3567, PASS_EDGE, OVERLAP))).toBe(`[${expectedTiles.join(',')}]`)
})
