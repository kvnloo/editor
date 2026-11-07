import type { DeepZoomZipArtifactHost, DeepZoomZipTemporaryArtifact } from './deep-zoom-zip'

const STAGING_DIRECTORY = '.deep-zoom-zip-staging'
const STAGING_LOCK = 'pascal-deep-zoom-zip-staging-v1'
const TEMPORARY_NAME = /^dzi-[0-9a-f-]{36}\.part$/

type MovableFileHandle = FileSystemFileHandle & {
  move?: (directory: FileSystemDirectoryHandle, name: string) => Promise<void>
}

type ExclusiveLockManager = {
  request(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<void>,
  ): Promise<unknown>
}

export interface BrowserDeepZoomZipArtifactHost extends DeepZoomZipArtifactHost {
  getPublished(filename: string): Promise<Blob | undefined>
  /** Removes incomplete stages from an interrupted page, never published ZIPs. */
  recoverAbandonedStages(): Promise<number>
}

export interface BrowserDeepZoomZipHostOptions {
  /** A host-authorized OPFS or File System Access directory; null forces the Blob fallback. */
  directory?: FileSystemDirectoryHandle | null
  /** Refuse memory fallback for captures that must stay bounded on disk. */
  requireStagedFile?: boolean
  /** Defaults to the browser's cross-tab Web Locks manager. */
  lockManager?: ExclusiveLockManager
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

/**
 * Chromium OPFS move replaces an existing destination. Hold one origin-wide Web Lock
 * throughout staging and the final existence check + move to prevent cooperating
 * tabs from overwriting each other's completed ZIPs.
 */
async function acquireStageLock(manager: ExclusiveLockManager): Promise<() => void> {
  let acquired!: () => void
  let failed!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve
    failed = reject
  })
  let unlock!: () => void
  const held = new Promise<void>((resolve) => {
    unlock = resolve
  })
  try {
    void manager
      .request(STAGING_LOCK, { mode: 'exclusive' }, async () => {
        acquired()
        await held
      })
      .catch(failed)
  } catch (error) {
    failed(error)
  }
  await ready
  let released = false
  return () => {
    if (released) return
    released = true
    unlock()
  }
}

async function clearAbandonedStages(staging: FileSystemDirectoryHandle): Promise<number> {
  const enumerable = staging as FileSystemDirectoryHandle & {
    entries(): AsyncIterable<[string, FileSystemHandle]>
  }
  if (typeof enumerable.entries !== 'function') {
    throw new Error('This browser cannot enumerate abandoned DeepZoom staging files')
  }
  const abandoned: string[] = []
  for await (const [name, entry] of enumerable.entries()) {
    if (entry.kind === 'file' && TEMPORARY_NAME.test(name)) abandoned.push(name)
  }
  for (const name of abandoned) await removeIfPresent(staging, name)
  return abandoned.length
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
  locks: ExclusiveLockManager | undefined,
): Promise<DeepZoomZipTemporaryArtifact | undefined> {
  if (!globalThis.crypto?.randomUUID || !locks) return undefined

  const unlock = await acquireStageLock(locks)
  try {
    // The lease excludes live stages in other same-origin tabs while recovering after reload.
    const staging = await directory.getDirectoryHandle(STAGING_DIRECTORY, { create: true })
    await clearAbandonedStages(staging)
    const temporaryName = 'dzi-' + globalThis.crypto.randomUUID() + '.part'
    const file = (await staging.getFileHandle(temporaryName, { create: true })) as MovableFileHandle

    if (typeof file.move !== 'function' || typeof file.isSameEntry !== 'function') {
      await removeIfPresent(staging, temporaryName)
      unlock()
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
        const destination = await findFile(directory, filename)
        if (!destination || !(await destination.isSameEntry(file))) {
          throw new Error('DeepZoom ZIP publication could not verify its file identity')
        }
        published = true
        unlock()
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
          try {
            await removeIfPresent(staging, temporaryName)
          } finally {
            unlock()
          }
        }
      },
    }
  } catch (error) {
    unlock()
    throw error
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
 * Stages in a private directory and atomically moves the finalized ZIP into the
 * host-authorized destination. Cross-tab writers must honor the same Web Lock.
 * Unsupported persistent staging may fall back to an in-memory Blob when allowed.
 */
export async function createBrowserDeepZoomZipArtifactHost(
  options: BrowserDeepZoomZipHostOptions = {},
): Promise<BrowserDeepZoomZipArtifactHost> {
  const directory =
    options.directory === undefined ? await originPrivateDirectory() : options.directory
  const locks = options.lockManager ?? globalThis.navigator?.locks
  const published = new Map<string, Blob>()

  return {
    async stage() {
      if (directory) {
        const stagedFile = await fileStage(directory, locks)
        if (stagedFile) return stagedFile
      }
      if (options.requireStagedFile) {
        throw new Error('Persistent DeepZoom ZIP staging requires OPFS move and Web Locks')
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
    async recoverAbandonedStages() {
      if (!directory) return 0
      if (!locks) throw new Error('DeepZoom ZIP recovery requires cross-tab Web Locks')
      const unlock = await acquireStageLock(locks)
      try {
        const staging = await directory.getDirectoryHandle(STAGING_DIRECTORY, { create: true })
        return await clearAbandonedStages(staging)
      } finally {
        unlock()
      }
    },
  }
}
