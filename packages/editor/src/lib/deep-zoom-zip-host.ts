import type { DeepZoomZipArtifactHost, DeepZoomZipTemporaryArtifact } from './deep-zoom-zip'

const STAGING_DIRECTORY = '.deep-zoom-zip-staging'

type MovableFileHandle = FileSystemFileHandle & {
  move?: (directory: FileSystemDirectoryHandle, name: string) => Promise<void>
}

export interface BrowserDeepZoomZipArtifactHost extends DeepZoomZipArtifactHost {
  getPublished(filename: string): Promise<Blob | undefined>
}

export interface BrowserDeepZoomZipHostOptions {
  /** A host-authorized OPFS or File System Access directory; null forces the Blob fallback. */
  directory?: FileSystemDirectoryHandle | null
  /** Refuse memory fallback for captures that must stay bounded on disk. */
  requireStagedFile?: boolean
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotFoundError'
  )
}

function validateFilename(filename: string): void {
  if (!/^[\p{L}\p{N}_][\p{L}\p{N} ._-]*\.zip$/u.test(filename)) {
    throw new RangeError('filename must be a safe ZIP basename')
  }
}

async function findFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

function memoryStage(
  published: Map<string, Blob>,
  directory: FileSystemDirectoryHandle | null,
): DeepZoomZipTemporaryArtifact {
  const chunks: Uint8Array[] = []
  let finished = false
  let ownPublication: { filename: string; blob: Blob } | null = null

  return {
    write(chunk) {
      if (finished) throw new Error('ZIP staging is already finished')
      chunks.push(new Uint8Array(chunk))
    },
    async publish(filename) {
      if (finished) throw new Error('ZIP staging is already finished')
      validateFilename(filename)
      if (published.has(filename) || (directory && (await findFile(directory, filename)))) {
        throw new Error('ZIP artifact already exists: ' + filename)
      }
      const blob = new Blob(chunks.map((chunk) => new Uint8Array(chunk)), {
        type: 'application/zip',
      })
      published.set(filename, blob)
      ownPublication = { filename, blob }
      finished = true
      chunks.length = 0
    },
    discard() {
      if (ownPublication && published.get(ownPublication.filename) === ownPublication.blob) {
        published.delete(ownPublication.filename)
      }
      ownPublication = null
      finished = true
      chunks.length = 0
    },
  }
}

async function fileStage(
  directory: FileSystemDirectoryHandle,
): Promise<DeepZoomZipTemporaryArtifact | undefined> {
  if (!globalThis.crypto?.randomUUID) return undefined

  // Only the root is a published artifact namespace; partial ZIPs live in a child directory.
  const staging = await directory.getDirectoryHandle(STAGING_DIRECTORY, { create: true })
  const temporaryName = 'dzi-' + globalThis.crypto.randomUUID() + '.part'
  const file = (await staging.getFileHandle(temporaryName, { create: true })) as MovableFileHandle

  // Closing a writable does not atomically create a new destination name. Without move and
  // identity checks, publishing to the root cannot satisfy the rollback contract.
  if (typeof file.move !== 'function' || typeof file.isSameEntry !== 'function') {
    await removeIfPresent(staging, temporaryName)
    return undefined
  }

  let writable: FileSystemWritableFileStream
  try {
    writable = await file.createWritable()
  } catch (error) {
    await removeIfPresent(staging, temporaryName)
    throw error
  }

  let closed = false
  let published = false
  let discarded = false
  let attemptedName: string | undefined

  return {
    async write(chunk) {
      if (closed || published || discarded) throw new Error('ZIP staging is already finished')
      await writable.write(new Uint8Array(chunk))
    },
    async publish(filename) {
      if (closed || published || discarded) throw new Error('ZIP staging is already finished')
      validateFilename(filename)
      await writable.close()
      closed = true
      if (await findFile(directory, filename)) {
        throw new Error('ZIP artifact already exists: ' + filename)
      }
      attemptedName = filename
      await file.move!(directory, filename)
      published = true
    },
    async discard() {
      if (discarded) return
      discarded = true
      if (!closed) {
        try {
          await writable.abort()
        } catch {
          // Removing the private staging file is the authoritative rollback.
        }
        closed = true
      }
      try {
        // A rejected move or failed host delivery can leave our own published file.
        // Never delete another file with the same name.
        if (attemptedName) {
          const destination = await findFile(directory, attemptedName)
          if (destination && (await destination.isSameEntry(file))) {
            await directory.removeEntry(attemptedName)
          }
        }
      } finally {
        await removeIfPresent(staging, temporaryName)
      }
    },
  }
}

async function originPrivateDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) return null
  try {
    return await storage.getDirectory()
  } catch {
    return null
  }
}

/**
 * Uses OPFS atomic move when the browser supports it, otherwise publishes a Blob in memory.
 * The host supplies directory access/authorization; no public files exist before publish.
 * In-memory artifacts can be retrieved through getPublished and handed to a download UI.
 */
export async function createBrowserDeepZoomZipArtifactHost(
  options: BrowserDeepZoomZipHostOptions = {},
): Promise<BrowserDeepZoomZipArtifactHost> {
  const directory =
    options.directory === undefined ? await originPrivateDirectory() : options.directory
  const published = new Map<string, Blob>()

  return {
    async stage() {
      if (directory) {
        const stagedFile = await fileStage(directory)
        if (stagedFile) return stagedFile
      }
      if (options.requireStagedFile) {
        throw new Error('Persistent DeepZoom ZIP staging is unavailable')
      }
      return memoryStage(published, directory)
    },
    async getPublished(filename) {
      validateFilename(filename)
      const blob = published.get(filename)
      if (blob) return blob
      if (!directory) return undefined
      const file = await findFile(directory, filename)
      return file?.getFile()
    },
  }
}
