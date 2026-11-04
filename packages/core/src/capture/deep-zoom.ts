export interface DeepZoomTile {
  col: number
  row: number
  x: number
  y: number
  w: number
  h: number
}

export interface DeepZoomDescriptorOptions {
  width: number
  height: number
  tileSize: number
  overlap: number
  format: string
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}

function assertTileOptions(tileSize: number, overlap: number): void {
  assertPositiveInteger(tileSize, 'tileSize')
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap > tileSize) {
    throw new RangeError('overlap must be an integer from 0 through tileSize')
  }
}

export function deepZoomMaxLevel(width: number, height: number): number {
  assertPositiveInteger(width, 'width')
  assertPositiveInteger(height, 'height')
  return Math.ceil(Math.log2(Math.max(width, height)))
}

export function deepZoomLevelSize(
  width: number,
  height: number,
  level: number,
): [number, number] {
  const maxLevel = deepZoomMaxLevel(width, height)
  if (!Number.isSafeInteger(level) || level < 0 || level > maxLevel) {
    throw new RangeError('level must be an integer from 0 through the maximum level')
  }
  const downsample = 2 ** (maxLevel - level)
  return [Math.ceil(width / downsample), Math.ceil(height / downsample)]
}

export function deepZoomTiles(
  levelW: number,
  levelH: number,
  tileSize: number,
  overlap: number,
): DeepZoomTile[] {
  assertPositiveInteger(levelW, 'levelW')
  assertPositiveInteger(levelH, 'levelH')
  assertTileOptions(tileSize, overlap)

  const cols = Math.ceil(levelW / tileSize)
  const rows = Math.ceil(levelH / tileSize)
  const tiles: DeepZoomTile[] = []

  for (let row = 0; row < rows; row++) {
    const y = row * tileSize - (row > 0 ? overlap : 0)
    const bottom = Math.min(levelH, (row + 1) * tileSize + overlap)

    for (let col = 0; col < cols; col++) {
      const x = col * tileSize - (col > 0 ? overlap : 0)
      const right = Math.min(levelW, (col + 1) * tileSize + overlap)
      tiles.push({ col, row, x, y, w: right - x, h: bottom - y })
    }
  }

  return tiles
}

export function deepZoomDescriptor({
  width,
  height,
  tileSize,
  overlap,
  format,
}: DeepZoomDescriptorOptions): string {
  assertPositiveInteger(width, 'width')
  assertPositiveInteger(height, 'height')
  assertTileOptions(tileSize, overlap)
  if (typeof format !== 'string' || format.trim().length === 0) {
    throw new RangeError('format must be a non-empty string')
  }
  const escapedFormat = format
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="${tileSize}" Overlap="${overlap}" Format="${escapedFormat}">
  <Size Width="${width}" Height="${height}" />
</Image>`
}
