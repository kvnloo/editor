import { type Tile, tileGrid } from '../lib/tile-plan'
import { type DeepZoomTile, deepZoomTiles } from './deep-zoom'

export interface GigapixelCaptureOptions {
  width: number
  height: number
  passEdge: number
  tileSize: number
  overlap: number
  renderOverlap: number
}

export interface GigapixelCaptureFragment {
  /** DeepZoom tile identity at the maximum level. */
  col: number
  row: number
  /** Global image pixels to copy from the render pass into that DZI tile. */
  x: number
  y: number
  w: number
  h: number
}

export interface GigapixelCapturePass {
  render: Tile
  fragments: GigapixelCaptureFragment[]
  emittedTiles: DeepZoomTile[]
  /** Source pixels retained for unfinished DZI tiles after this pass is released. */
  retainedPixelsAfter: number
}

export interface GigapixelCapturePlan {
  passes: GigapixelCapturePass[]
  /**
   * Conservative high-water source-pixel count: one render readback buffer,
   * previously retained tile fragments, and newly staged fragments before
   * completed tiles are emitted. Excludes the encoder's own output buffer.
   */
  peakResidentPixels: number
}

function fragmentWithin(
  inner: Tile['inner'],
  dzi: DeepZoomTile,
): GigapixelCaptureFragment | null {
  const x = Math.max(inner.x, dzi.x)
  const y = Math.max(inner.y, dzi.y)
  const right = Math.min(inner.x + inner.w, dzi.x + dzi.w)
  const bottom = Math.min(inner.y + inner.h, dzi.y + dzi.h)
  if (right <= x || bottom <= y) return null
  return { col: dzi.col, row: dzi.row, x, y, w: right - x, h: bottom - y }
}

/**
 * Plan readbacks in tileGrid order and emit each maximum-level DZI tile on
 * the first pass that completes its canonical source pixels.
 *
 * Render overlap is a seam-sampling margin. Only tileGrid.inner contributes
 * pixels; this avoids competing copies of a pixel from adjacent passes.
 * Every unfinished DZI tile retains only its already-read fragments, never
 * a whole earlier render buffer.
 */
export function planGigapixelCapture({
  width,
  height,
  passEdge,
  tileSize,
  overlap,
  renderOverlap,
}: GigapixelCaptureOptions): GigapixelCapturePlan {
  for (const [name, value] of [
    ['width', width],
    ['height', height],
    ['passEdge', passEdge],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(name + ' must be a positive safe integer')
    }
  }
  if (
    !Number.isSafeInteger(renderOverlap) ||
    renderOverlap < 0 ||
    2 * renderOverlap >= passEdge
  ) {
    throw new RangeError('renderOverlap must leave positive pass interior')
  }
  if (!Number.isSafeInteger(width * height) || !Number.isSafeInteger(passEdge ** 2)) {
    throw new RangeError('pixel counts must be safe integers')
  }

  const dziTiles = deepZoomTiles(width, height, tileSize, overlap)
  const renderPasses = tileGrid(width, height, passEdge, renderOverlap)
  const unreadPixels = dziTiles.map((tile) => tile.w * tile.h)
  const heldPixels = dziTiles.map(() => 0)
  const passes: GigapixelCapturePass[] = []
  let cachedPixels = 0
  let peakResidentPixels = 0

  for (const render of renderPasses) {
    const fragments: GigapixelCaptureFragment[] = []
    const emittedTiles: DeepZoomTile[] = []
    let stagedPixels = 0
    let releasedPixels = 0

    for (const [index, dzi] of dziTiles.entries()) {
      const fragment = fragmentWithin(render.inner, dzi)
      if (!fragment) continue
      fragments.push(fragment)

      const pixels = fragment.w * fragment.h
      const unread = unreadPixels[index]! - pixels
      if (unread < 0) {
        throw new Error('render pass interiors overlap DZI source pixels')
      }
      unreadPixels[index] = unread
      if (unread === 0) {
        emittedTiles.push(dzi)
        releasedPixels += heldPixels[index]!
        heldPixels[index] = 0
      } else {
        heldPixels[index] = heldPixels[index]! + pixels
        stagedPixels += pixels
      }
    }

    // Stage unfinished fragments before releasing completed ones: a safe
    // peak even for sinks that copy all fragments before emitting tiles.
    peakResidentPixels = Math.max(
      peakResidentPixels,
      cachedPixels + render.w * render.h + stagedPixels,
    )
    cachedPixels += stagedPixels - releasedPixels
    passes.push({ render, fragments, emittedTiles, retainedPixelsAfter: cachedPixels })
  }

  if (unreadPixels.some((pixels) => pixels !== 0) || cachedPixels !== 0) {
    throw new Error('capture plan left DZI tiles incomplete')
  }

  return { passes, peakResidentPixels }
}
