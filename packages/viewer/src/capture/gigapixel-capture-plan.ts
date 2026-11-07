import { type Tile, tileGrid } from '../lib/tile-plan'
import { deepZoomLevelSize, deepZoomMaxLevel, deepZoomTiles, type DeepZoomTile } from './deep-zoom'

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
   * Conservative high-water RGBA pixel count: readback, all copied fragments
   * (including ready tiles), completed tiles, resident pyramid children, and
   * parent assembly/downsample buffers. Excludes encoder and ZIP output bytes.
   */
  peakResidentPixels: number
}


type PyramidParent = {
  tile: DeepZoomTile
  children: string[]
  remainingChildren: number
}

const tileKey = (col: number, row: number): string => col + '_' + row

/** Mirror the streamer's allocation/release order, including pyramid assembly. */
function peakResidentPixelsForPlan(
  passes: GigapixelCapturePass[],
  width: number,
  height: number,
  tileSize: number,
  overlap: number,
): number {
  const maxLevel = deepZoomMaxLevel(width, height)
  const sizes = Array.from({ length: maxLevel + 1 }, (_, level) =>
    deepZoomLevelSize(width, height, level),
  )
  const levels = sizes.map(([w, h]) => deepZoomTiles(w, h, tileSize, overlap))
  const parentsByLevel: Map<string, PyramidParent>[] = []
  const consumersByLevel: Map<string, string[]>[] = []

  for (let level = 0; level < maxLevel; level++) {
    const [childWidth, childHeight] = sizes[level + 1]!
    const parents = new Map<string, PyramidParent>()
    const byChild = new Map<string, string[]>()
    for (const parent of levels[level]!) {
      const sx = parent.x * 2
      const sy = parent.y * 2
      const sw = Math.min(childWidth - sx, parent.w * 2)
      const sh = Math.min(childHeight - sy, parent.h * 2)
      const children = levels[level + 1]!
        .filter(
          (child) =>
            child.x < sx + sw &&
            child.y < sy + sh &&
            child.x + child.w > sx &&
            child.y + child.h > sy,
        )
        .map((child) => tileKey(child.col, child.row))
      if (children.length === 0) throw new Error('DeepZoom parent has no source tiles')
      const parentKey = tileKey(parent.col, parent.row)
      parents.set(parentKey, { tile: parent, children, remainingChildren: children.length })
      for (const childKey of children) {
        const consumers = byChild.get(childKey) ?? []
        consumers.push(parentKey)
        byChild.set(childKey, consumers)
      }
    }
    parentsByLevel.push(parents)
    consumersByLevel.push(byChild)
  }

  const resident = Array.from(
    { length: maxLevel + 1 },
    () => new Map<string, { pixels: number; remainingConsumers: number }>(),
  )
  const incompleteCopies = new Map<string, number>()
  let livePixels = 0
  let peakPixels = 0
  const allocate = (pixels: number) => {
    livePixels += pixels
    if (!Number.isSafeInteger(livePixels)) {
      throw new RangeError('resident pixel count must be a safe integer')
    }
    peakPixels = Math.max(peakPixels, livePixels)
  }
  const release = (pixels: number) => {
    livePixels -= pixels
  }

  const emit = (level: number, tile: DeepZoomTile): void => {
    const pixels = tile.w * tile.h
    if (level === 0) {
      release(pixels)
      return
    }
    const id = tileKey(tile.col, tile.row)
    const requiredBy = consumersByLevel[level - 1]!.get(id) ?? []
    if (requiredBy.length === 0) throw new Error('DeepZoom tile has no pyramid parent')
    resident[level]!.set(id, { pixels, remainingConsumers: requiredBy.length })

    for (const parentKey of requiredBy) {
      const parent = parentsByLevel[level - 1]!.get(parentKey)
      if (!parent) throw new Error('DeepZoom parent dependency is missing')
      parent.remainingChildren -= 1
      if (parent.remainingChildren !== 0) continue
      const [childWidth, childHeight] = sizes[level]!
      const sx = parent.tile.x * 2
      const sy = parent.tile.y * 2
      const sw = Math.min(childWidth - sx, parent.tile.w * 2)
      const sh = Math.min(childHeight - sy, parent.tile.h * 2)
      allocate(sw * sh)
      allocate(parent.tile.w * parent.tile.h)
      release(sw * sh)

      for (const childKey of parent.children) {
        const child = resident[level]!.get(childKey)
        if (!child) throw new Error('DeepZoom child released before its parent')
        child.remainingConsumers -= 1
        if (child.remainingConsumers === 0) {
          resident[level]!.delete(childKey)
          release(child.pixels)
        }
      }
      emit(level - 1, parent.tile)
    }
  }

  for (const pass of passes) {
    const readbackPixels = pass.render.w * pass.render.h
    allocate(readbackPixels)
    for (const fragment of pass.fragments) {
      const id = tileKey(fragment.col, fragment.row)
      const pixels = fragment.w * fragment.h
      allocate(pixels)
      incompleteCopies.set(id, (incompleteCopies.get(id) ?? 0) + pixels)
    }
    release(readbackPixels)
    for (const tile of pass.emittedTiles) {
      const id = tileKey(tile.col, tile.row)
      const copiedPixels = incompleteCopies.get(id)
      if (copiedPixels === undefined) {
        throw new Error('Completed DeepZoom tile has no fragments')
      }
      allocate(tile.w * tile.h)
      emit(maxLevel, tile)
      release(copiedPixels)
      incompleteCopies.delete(id)
    }
  }
  if (incompleteCopies.size !== 0 || livePixels !== 0) {
    throw new Error('Capture budget left resident pixels unaccounted')
  }
  return peakPixels
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

    cachedPixels += stagedPixels - releasedPixels
    passes.push({ render, fragments, emittedTiles, retainedPixelsAfter: cachedPixels })
  }

  if (unreadPixels.some((pixels) => pixels !== 0) || cachedPixels !== 0) {
    throw new Error('capture plan left DZI tiles incomplete')
  }

  return {
    passes,
    peakResidentPixels: peakResidentPixelsForPlan(passes, width, height, tileSize, overlap),
  }
}
