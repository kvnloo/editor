import {
  deepZoomDescriptor,
  deepZoomLevelSize,
  deepZoomMaxLevel,
  type DeepZoomDescriptorOptions,
} from '@pascal-app/viewer/capture'
import { strToU8, Zip, ZipPassThrough } from 'fflate'

export interface DeepZoomZipOptions extends DeepZoomDescriptorOptions {
  name: string
}

export interface DeepZoomZipTile {
  level: number
  col: number
  row: number
  bytes: Uint8Array
}

/**
 * Writes a DZI descriptor and encoded tile files into a streaming ZIP.
 * The sink must consume or copy each emitted chunk before returning.
 */
export async function streamDeepZoomZip(
  options: DeepZoomZipOptions,
  tiles: AsyncIterable<DeepZoomZipTile> | Iterable<DeepZoomZipTile>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const { name, format, width, height, tileSize } = options
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N} ._-]*$/u.test(name)) {
    throw new RangeError('name must be a safe ZIP entry basename')
  }
  if (!/^[a-zA-Z0-9]+$/.test(format)) {
    throw new RangeError('format must be a filename extension')
  }

  const descriptor = deepZoomDescriptor(options)
  const maxLevel = deepZoomMaxLevel(width, height)
  const pending: Uint8Array[] = []
  let zipError: Error | null = null
  const zip = new Zip((error, chunk) => {
    if (error) {
      zipError = error
      return
    }
    // fflate is synchronous; drain after each entry before requesting another tile.
    pending.push(chunk.slice())
  })
  async function drain(): Promise<void> {
    for (const chunk of pending) await onChunk(chunk)
    pending.length = 0
    if (zipError) throw zipError
  }

  function addEntry(path: string, bytes: Uint8Array): void {
    const entry = new ZipPassThrough(path)
    zip.add(entry)
    entry.push(bytes, true)
  }

  addEntry(name + '.dzi', strToU8(descriptor))
  await drain()

  for await (const tile of tiles) {
    if (!Number.isSafeInteger(tile.level) || tile.level < 0 || tile.level > maxLevel) {
      throw new RangeError('tile level is outside the DeepZoom pyramid')
    }
    const [levelWidth, levelHeight] = deepZoomLevelSize(width, height, tile.level)
    if (
      !Number.isSafeInteger(tile.col) ||
      tile.col < 0 ||
      tile.col >= Math.ceil(levelWidth / tileSize) ||
      !Number.isSafeInteger(tile.row) ||
      tile.row < 0 ||
      tile.row >= Math.ceil(levelHeight / tileSize)
    ) {
      throw new RangeError('tile coordinates are outside the DeepZoom level')
    }
    if (!(tile.bytes instanceof Uint8Array)) {
      throw new TypeError('tile bytes must be a Uint8Array')
    }

    addEntry(
      name + '_files/' + tile.level + '/' + tile.col + '_' + tile.row + '.' + format,
      tile.bytes,
    )
    await drain()
  }

  zip.end()
  await drain()
}
