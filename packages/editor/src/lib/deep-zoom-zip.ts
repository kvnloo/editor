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
 * The sink must consume or copy each emitted chunk before resolving.
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
  // fflate does not await its callback; serialize chunks before requesting another entry.
  let drained: Promise<void> = Promise.resolve()
  const zip = new Zip((error, chunk) => {
    drained = drained.then(() => {
      if (error) throw error
      return onChunk(chunk)
    })
  })

  async function addEntry(path: string, bytes: Uint8Array): Promise<void> {
    const entry = new ZipPassThrough(path)
    zip.add(entry)
    entry.push(bytes, true)
    await drained
  }

  await addEntry(name + '.dzi', strToU8(descriptor))

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

    await addEntry(
      name + '_files/' + tile.level + '/' + tile.col + '_' + tile.row + '.' + format,
      tile.bytes,
    )
  }

  zip.end()
  await drained
}
