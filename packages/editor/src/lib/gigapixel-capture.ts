import {
  deepZoomLevelSize,
  deepZoomMaxLevel,
  deepZoomTiles,
  halveRgba,
  planGigapixelCapture,
  type DeepZoomTile,
  type GigapixelCaptureFragment,
  type GigapixelCaptureOptions,
  type GigapixelCapturePass,
} from '@pascal-app/viewer/capture'
import { streamDeepZoomZip, type DeepZoomZipTile } from './deep-zoom-zip'
import type { GigapixelArtifactReceipt, GigapixelArtifactSink } from './gigapixel-artifact-sink'

export interface StreamGigapixelOptions extends GigapixelCaptureOptions {
  name: string
  signal?: AbortSignal
}

export type GigapixelRenderPass = (
  render: GigapixelCapturePass['render'],
) => Uint8ClampedArray | Promise<Uint8ClampedArray>

export type GigapixelEncodeTile = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) => Uint8Array | Promise<Uint8Array>

export interface StreamGigapixelStats {
  passes: number
  tilesWritten: number
  /** One readback plus retained unfinished source fragments, excluding output tiles and ZIP. */
  peakResidentPixels: number
  planPeakResidentPixels: number
  artifact: GigapixelArtifactReceipt
}

interface Piece {
  fragment: GigapixelCaptureFragment
  data: Uint8ClampedArray
  retained: boolean
}

interface ResidentTile {
  tile: DeepZoomTile
  data: Uint8ClampedArray
  remainingConsumers: number
}

interface ParentState {
  tile: DeepZoomTile
  children: string[]
  remainingChildren: number
}

const key = (col: number, row: number): string => col + '_' + row

function copyRect(
  source: Uint8ClampedArray,
  sourceWidth: number,
  fromX: number,
  fromY: number,
  target: Uint8ClampedArray,
  targetWidth: number,
  toX: number,
  toY: number,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const start = ((fromY + y) * sourceWidth + fromX) * 4
    target.set(
      source.subarray(start, start + width * 4),
      ((toY + y) * targetWidth + toX) * 4,
    )
  }
}

/**
 * Stream captured pass pixels into max-level DZI tiles, then construct each
 * smaller level from the exact source rectangle of its completed children.
 * No level or render pass is assembled into a full-picture RGBA buffer.
 */
async function captureToSink(
  options: StreamGigapixelOptions,
  renderPass: GigapixelRenderPass,
  encode: GigapixelEncodeTile,
  sink: GigapixelArtifactSink,
): Promise<StreamGigapixelStats> {
  const checkCancelled = () => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException('Gigapixel capture cancelled', 'AbortError')
    }
  }
  checkCancelled()
  const plan = planGigapixelCapture(options)
  const { width, height, tileSize, overlap } = options
  const maxLevel = deepZoomMaxLevel(width, height)
  const sizes = Array.from({ length: maxLevel + 1 }, (_, level) =>
    deepZoomLevelSize(width, height, level),
  )
  const levels = sizes.map(([w, h]) => deepZoomTiles(w, h, tileSize, overlap))
  const dependencies: Array<{
    parents: Map<string, ParentState>
    byChild: Map<string, string[]>
  }> = []

  for (let level = 0; level < maxLevel; level++) {
    const [childWidth, childHeight] = sizes[level + 1]!
    const parents = new Map<string, ParentState>()
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
        .map((child) => key(child.col, child.row))
      if (children.length === 0) throw new Error('DeepZoom parent has no source tiles')
      const parentKey = key(parent.col, parent.row)
      parents.set(parentKey, { tile: parent, children, remainingChildren: children.length })
      for (const childKey of children) {
        const consumers = byChild.get(childKey) ?? []
        consumers.push(parentKey)
        byChild.set(childKey, consumers)
      }
    }
    dependencies.push({ parents, byChild })
  }

  const resident = Array.from(
    { length: maxLevel + 1 },
    () => new Map<string, ResidentTile>(),
  )
  const incomplete = new Map<string, Piece[]>()
  let retainedPixels = 0
  let peakResidentPixels = 0
  let tilesWritten = 0

  function assembleParent(level: number, parent: ParentState): Uint8ClampedArray {
    const [childWidth, childHeight] = sizes[level + 1]!
    const sx = parent.tile.x * 2
    const sy = parent.tile.y * 2
    const sw = Math.min(childWidth - sx, parent.tile.w * 2)
    const sh = Math.min(childHeight - sy, parent.tile.h * 2)
    const source = new Uint8ClampedArray(sw * sh * 4)

    for (const childKey of parent.children) {
      const child = resident[level + 1]!.get(childKey)
      if (!child) throw new Error('DeepZoom child released before its parent')
      const x = Math.max(sx, child.tile.x)
      const y = Math.max(sy, child.tile.y)
      const right = Math.min(sx + sw, child.tile.x + child.tile.w)
      const bottom = Math.min(sy + sh, child.tile.y + child.tile.h)
      copyRect(
        child.data,
        child.tile.w,
        x - child.tile.x,
        y - child.tile.y,
        source,
        sw,
        x - sx,
        y - sy,
        right - x,
        bottom - y,
      )
    }

    const result = halveRgba(source, sw, sh)
    if (result.width !== parent.tile.w || result.height !== parent.tile.h) {
      throw new Error('DeepZoom parent dimensions do not match downsampled pixels')
    }
    return result.data
  }

  async function* emitTile(
    level: number,
    tile: DeepZoomTile,
    data: Uint8ClampedArray,
  ): AsyncGenerator<DeepZoomZipTile> {
    checkCancelled()
    const bytes = await encode(data, tile.w, tile.h)
    checkCancelled()
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Encoder must return Uint8Array')
    tilesWritten += 1
    yield { level, col: tile.col, row: tile.row, bytes }
    await sink.write({ kind: 'tile' })

    if (level === 0) return
    const tileKey = key(tile.col, tile.row)
    const requiredBy = dependencies[level - 1]!.byChild.get(tileKey) ?? []
    if (requiredBy.length === 0) throw new Error('DeepZoom tile has no pyramid parent')
    resident[level]!.set(tileKey, {
      tile,
      data,
      remainingConsumers: requiredBy.length,
    })

    for (const parentKey of requiredBy) {
      const parent = dependencies[level - 1]!.parents.get(parentKey)
      if (!parent) throw new Error('DeepZoom parent dependency is missing')
      parent.remainingChildren -= 1
      if (parent.remainingChildren !== 0) continue
      const parentPixels = assembleParent(level - 1, parent)
      for (const childKey of parent.children) {
        const child = resident[level]!.get(childKey)
        if (!child) throw new Error('DeepZoom child was consumed twice')
        child.remainingConsumers -= 1
        if (child.remainingConsumers === 0) resident[level]!.delete(childKey)
      }
      yield* emitTile(level - 1, parent.tile, parentPixels)
    }
  }

  async function* capturedTiles(): AsyncGenerator<DeepZoomZipTile> {
    try {
      for (const pass of plan.passes) {
        checkCancelled()
        const { render } = pass
        let rgba: Uint8ClampedArray | null = await renderPass(render)
        checkCancelled()
        if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== render.w * render.h * 4) {
          throw new Error('Render pass must return tightly packed RGBA pixels')
        }
        const ready = new Set(pass.emittedTiles.map((tile) => key(tile.col, tile.row)))
        peakResidentPixels = Math.max(peakResidentPixels, render.w * render.h + retainedPixels)

        for (const fragment of pass.fragments) {
          const pieceData = new Uint8ClampedArray(fragment.w * fragment.h * 4)
          copyRect(
            rgba,
            render.w,
            fragment.x - render.x,
            fragment.y - render.y,
            pieceData,
            fragment.w,
            0,
            0,
            fragment.w,
            fragment.h,
          )
          const fragmentKey = key(fragment.col, fragment.row)
          const pieces = incomplete.get(fragmentKey) ?? []
          const retained = !ready.has(fragmentKey)
          pieces.push({ fragment, data: pieceData, retained })
          incomplete.set(fragmentKey, pieces)
          if (retained) retainedPixels += fragment.w * fragment.h
          peakResidentPixels = Math.max(
            peakResidentPixels,
            render.w * render.h + retainedPixels,
          )
        }

        // Drop the GPU readback before allocating completed tiles or encoding them.
        rgba = null
        for (const tile of pass.emittedTiles) {
          const tileKey = key(tile.col, tile.row)
          const pieces = incomplete.get(tileKey)
          if (!pieces) throw new Error('Completed DeepZoom tile has no fragments')
          const data = new Uint8ClampedArray(tile.w * tile.h * 4)
          for (const piece of pieces) {
            copyRect(
              piece.data,
              piece.fragment.w,
              0,
              0,
              data,
              tile.w,
              piece.fragment.x - tile.x,
              piece.fragment.y - tile.y,
              piece.fragment.w,
              piece.fragment.h,
            )
            if (piece.retained) retainedPixels -= piece.fragment.w * piece.fragment.h
          }
          incomplete.delete(tileKey)
          yield* emitTile(maxLevel, tile, data)
        }

        if (retainedPixels !== pass.retainedPixelsAfter) {
          throw new Error('Retained source fragments differ from the capture plan')
        }
      }

      if (incomplete.size !== 0 || retainedPixels !== 0) {
        throw new Error('Unfinished source fragments at the end of capture')
      }
      if (resident.some((level) => level.size !== 0)) {
        throw new Error('Unfinished DeepZoom pyramid after capture')
      }
      const expectedTileCount = levels.reduce((count, tiles) => count + tiles.length, 0)
      if (tilesWritten !== expectedTileCount) {
        throw new Error('DeepZoom ZIP is missing pyramid tiles')
      }
    } finally {
      incomplete.clear()
      for (const level of resident) level.clear()
    }
  }

  await streamDeepZoomZip({ ...options, format: 'webp' }, capturedTiles(), (chunk) =>
    sink.write({ kind: 'zip-chunk', bytes: chunk }),
  )
  checkCancelled()
  if (peakResidentPixels > plan.peakResidentPixels) {
    throw new Error('Readback and retained fragments exceeded the capture plan')
  }

  const artifact = await sink.finish()
  return {
    passes: plan.passes.length,
    tilesWritten,
    peakResidentPixels,
    planPeakResidentPixels: plan.peakResidentPixels,
    artifact,
  }
}

/** A failed render, encoder, ZIP write, or cancellation never commits the artifact. */
export async function streamGigapixelCapture(
  options: StreamGigapixelOptions,
  renderPass: GigapixelRenderPass,
  encode: GigapixelEncodeTile,
  sink: GigapixelArtifactSink,
): Promise<StreamGigapixelStats> {
  try {
    return await captureToSink(options, renderPass, encode, sink)
  } catch (error) {
    try {
      await sink.abort()
    } catch (abortError) {
      throw new AggregateError([error, abortError], 'Gigapixel capture and cleanup failed')
    }
    throw error
  }
}
