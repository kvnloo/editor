import type { PlanGigapixelCaptureInput } from '../agent-tools/plan-gigapixel-capture'
import { refuse } from '../agent-tools/refusal'
import {
  deepZoomDescriptor,
  deepZoomLevelSize,
  deepZoomMaxLevel,
} from '../capture/deep-zoom'
import type { AgentOperation } from './types'

function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse(
      'capture_plan_too_large',
      'The capture plan exceeds safe integer pixel or byte counts. Use smaller dimensions.',
    )
  }
  return value
}

/** Sum the actual tile widths on an axis, including clipped overlap at the final edge. */
function overlappingAxisPixels(length: number, tileSize: number, overlap: number): number {
  const count = Math.ceil(length / tileSize)
  if (count === 1) return length
  const lastWidth = length - (count - 1) * tileSize
  return safeCount(length + (2 * count - 3) * overlap + Math.min(overlap, lastWidth))
}

function resolveDimensions(input: PlanGigapixelCaptureInput): [number, number] {
  const { width, height, megapixels } = input
  if (megapixels === undefined) {
    if (width === undefined || height === undefined) {
      refuse(
        'dimensions_required',
        'Provide both width and height in pixels, or megapixels with at most one dimension.',
      )
    }
    return [width, height]
  }
  if (width !== undefined && height !== undefined) {
    refuse(
      'dimensions_conflict',
      'Choose width and height, or megapixels with at most one dimension, not all three.',
    )
  }
  const targetPixels = megapixels * 1_000_000
  safeCount(Math.ceil(targetPixels))
  if (width !== undefined) return [width, Math.max(1, Math.ceil(targetPixels / width))]
  if (height !== undefined) return [Math.max(1, Math.ceil(targetPixels / height)), height]
  const side = Math.max(1, Math.ceil(Math.sqrt(targetPixels)))
  return [side, side]
}

/** Read-only sizing; no renderer, canvas, tile allocations, or scene state required. */
export const planGigapixelCapture: AgentOperation<PlanGigapixelCaptureInput> = (_nodes, input) => {
  const { tileSize, overlap, format } = input
  if (overlap > tileSize) {
    refuse('invalid_tile_overlap', 'Overlap must be no larger than tileSize.', {
      tileSize,
      overlap,
    })
  }
  const [width, height] = resolveDimensions(input)
  safeCount(width)
  safeCount(height)
  safeCount(width * height)
  const maxLevel = deepZoomMaxLevel(width, height)
  let totalTiles = 0
  let sampledPixels = 0
  const levels: {
    level: number
    width: number
    height: number
    columns: number
    rows: number
    tileCount: number
  }[] = []

  for (let level = 0; level <= maxLevel; level++) {
    const [levelWidth, levelHeight] = deepZoomLevelSize(width, height, level)
    const columns = Math.ceil(levelWidth / tileSize)
    const rows = Math.ceil(levelHeight / tileSize)
    const tileCount = safeCount(columns * rows)
    totalTiles = safeCount(totalTiles + tileCount)
    const tilePixels = safeCount(
      overlappingAxisPixels(levelWidth, tileSize, overlap) *
        overlappingAxisPixels(levelHeight, tileSize, overlap),
    )
    sampledPixels = safeCount(sampledPixels + tilePixels)
    safeCount(sampledPixels * 4)
    levels.push({ level, width: levelWidth, height: levelHeight, columns, rows, tileCount })
  }

  return {
    result: {
      width,
      height,
      tileSize,
      overlap,
      format,
      maxLevel,
      levelCount: maxLevel + 1,
      levels,
      totalTiles,
      estimatedBytes: sampledPixels * 4,
      estimateBasis: 'raw_rgba_tiles_including_overlap',
      dzi: deepZoomDescriptor({ width, height, tileSize, overlap, format }),
    },
  }
}
