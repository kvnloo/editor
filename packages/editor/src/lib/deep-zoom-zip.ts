import {
  type DeepZoomDescriptorOptions,
  deepZoomDescriptor,
  deepZoomLevelSize,
  deepZoomMaxLevel,
} from '@pascal-app/viewer/capture'
import { strToU8, Zip, ZipPassThrough } from 'fflate'

export interface DeepZoomZipOptions extends DeepZoomDescriptorOptions {
  name: string
  signal?: AbortSignal
  onCleanup?: () => void | Promise<void>
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
  const { name, format, width, height, tileSize, signal, onCleanup } = options
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

  const checkAbort = () => {
    if (signal?.aborted) {
      const error = new Error('DeepZoom ZIP writing aborted')
      error.name = 'AbortError'
      throw error
    }
  }

  try {
    checkAbort()
    await addEntry(name + '.dzi', strToU8(descriptor))

    for await (const tile of tiles) {
      checkAbort()
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

    checkAbort()
    zip.end()
    await drained
    checkAbort()
  } catch (error) {
    try {
      await onCleanup?.()
    } catch {
      // Preserve the original sink or cancellation error.
    }
    throw error
  }
}

/**
 * A host-owned temporary artifact. Staged bytes must be hidden from readers.
 * publish must atomically expose a complete artifact or reject without exposing it.
 */
export interface DeepZoomZipTemporaryArtifact {
  write(chunk: Uint8Array): void | Promise<void>
  publish(filename: string): void | Promise<void>
  discard(): void | Promise<void>
}

export interface DeepZoomZipArtifactHost {
  stage(): DeepZoomZipTemporaryArtifact | Promise<DeepZoomZipTemporaryArtifact>
}

/** Stages the entire ZIP before allowing the host to publish it. */
export async function persistDeepZoomZip(
  options: DeepZoomZipOptions,
  tiles: AsyncIterable<DeepZoomZipTile> | Iterable<DeepZoomZipTile>,
  host: DeepZoomZipArtifactHost,
): Promise<void> {
  const staged = await host.stage()
  try {
    // Keep writer cleanup in this transaction so failure rolls back exactly once.
    await streamDeepZoomZip({ ...options, onCleanup: undefined }, tiles, (chunk) =>
      staged.write(chunk),
    )
    if (options.signal?.aborted) {
      const error = new Error('DeepZoom ZIP writing aborted')
      error.name = 'AbortError'
      throw error
    }
    await staged.publish(options.name + '.zip')
  } catch (error) {
    let rollbackError: unknown
    try {
      await staged.discard()
    } catch (cause) {
      rollbackError = cause
    }
    try {
      await options.onCleanup?.()
    } catch {
      // Preserve the original failure, as the streaming writer does.
    }
    if (rollbackError !== undefined) {
      throw new AggregateError([error, rollbackError], 'DeepZoom ZIP rollback failed')
    }
    throw error
  }
}

export {
  type BrowserDeepZoomZipArtifactHost,
  type BrowserDeepZoomZipHostOptions,
  createBrowserDeepZoomZipArtifactHost,
} from './deep-zoom-zip-host'
