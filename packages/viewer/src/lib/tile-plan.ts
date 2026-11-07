export type Tile = {
  /** The zero-based column and row of the tile in the picture. */
  col: number
  row: number
  /** The pixels the tile renders, overlap included. */
  x: number
  y: number
  w: number
  h: number
  /** The pixels it contributes to the picture. */
  inner: { x: number; y: number; w: number; h: number }
}

/**
 * A `width × height` picture split into equal tiles no larger than
 * `passEdge`, each rendered `overlap` pixels past its inner edges so
 * screen-space passes can sample across seams.
 * One tile when the picture fits a pass.
 */
export function tileGrid(width: number, height: number, passEdge: number, overlap: number): Tile[] {
  for (const [name, value] of [
    ['width', width],
    ['height', height],
    ['passEdge', passEdge],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  if (!Number.isSafeInteger(overlap) || overlap < 0 || 2 * overlap >= passEdge) {
    throw new RangeError('overlap must be a non-negative safe integer with 2 * overlap < passEdge')
  }

  const room = passEdge - 2 * overlap
  const cols = width <= passEdge ? 1 : Math.ceil(width / room)
  const rows = height <= passEdge ? 1 : Math.ceil(height / room)
  const tiles: Tile[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ix = Math.round((col * width) / cols)
      const iy = Math.round((row * height) / rows)
      const iw = Math.round(((col + 1) * width) / cols) - ix
      const ih = Math.round(((row + 1) * height) / rows) - iy
      const x = Math.max(0, ix - overlap)
      const y = Math.max(0, iy - overlap)
      const w = Math.min(width, ix + iw + overlap) - x
      const h = Math.min(height, iy + ih + overlap) - y
      tiles.push({ col, row, x, y, w, h, inner: { x: ix, y: iy, w: iw, h: ih } })
    }
  }
  return tiles
}
