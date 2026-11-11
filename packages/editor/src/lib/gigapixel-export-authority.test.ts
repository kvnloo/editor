import { describe, expect, test } from 'bun:test'
import { createStagedGigapixelArtifactSink } from '@pascal-app/editor/gigapixel-artifact-sink'
import { streamGigapixelCapture } from '@pascal-app/editor/gigapixel-capture'
import {
  assertGigapixelExportStillActive,
  requireGigapixelExportAuthority,
  type AuthorizeGigapixelExport,
  type GigapixelExportDenialCode,
} from '@pascal-app/editor/gigapixel-export-authority'
import { unzipSync } from 'fflate'

const directory = {
  kind: 'directory',
  getDirectoryHandle: async () => directory,
  getFileHandle: async () => {
    throw new DOMException('File not found', 'NotFoundError')
  },
  removeEntry: async () => {},
} as unknown as FileSystemDirectoryHandle

const approve: AuthorizeGigapixelExport = (projectId) => ({
  status: 'authorized',
  projectId,
  directory,
})
const forbid: AuthorizeGigapixelExport = () => ({
  status: 'denied',
  code: 'permission_denied',
})
const unavailable: AuthorizeGigapixelExport = () => ({
  status: 'denied',
  code: 'export_unavailable',
})

interface Effects {
  tileReads: number
  fileCreations: number
  published: Blob | null
}

function effects(): Effects {
  return { tileReads: 0, fileCreations: 0, published: null }
}

/** Published entry -> authority -> staged artifact -> real ZIP capture producer. */
async function attempt(
  activeProjectId: () => string | null,
  requestedProjectId: string | undefined,
  authorize: AuthorizeGigapixelExport | undefined,
  activity: Effects,
) {
  const grant = await requireGigapixelExportAuthority(
    activeProjectId,
    requestedProjectId,
    authorize,
  )
  expect(grant.directory).toBe(directory)
  const sink = await createStagedGigapixelArtifactSink(
    {
      stage() {
        activity.fileCreations += 1
        const chunks: Uint8Array[] = []
        return {
          write(chunk) {
            chunks.push(chunk.slice())
          },
          publish(filename) {
            expect(filename).toBe('capture.zip')
            activity.published = new Blob(chunks, { type: 'application/zip' })
          },
          discard() {
            chunks.length = 0
            activity.published = null
          },
        }
      },
    },
    'capture.zip',
  )
  return streamGigapixelCapture(
    {
      name: 'capture',
      width: 2,
      height: 2,
      passEdge: 4,
      tileSize: 1,
      overlap: 0,
      renderOverlap: 0,
    },
    (pass) => {
      activity.tileReads += 1
      return new Uint8ClampedArray(pass.w * pass.h * 4).fill(255)
    },
    (rgba) => new Uint8Array(rgba),
    sink,
  )
}

describe('published gigapixel export authority', () => {
  const deniedCases: {
    name: string
    current: string | null
    requested?: string
    authorize?: AuthorizeGigapixelExport
    code: GigapixelExportDenialCode
  }[] = [
    { name: 'no active project', current: null, authorize: approve, code: 'no_project' },
    {
      name: 'requested project differs from active project',
      current: 'project-a',
      requested: 'project-b',
      authorize: approve,
      code: 'permission_denied',
    },
    {
      name: 'host refuses export permission',
      current: 'project-a',
      authorize: forbid,
      code: 'permission_denied',
    },
    {
      name: 'host has no export authorizer',
      current: 'project-a',
      code: 'export_unavailable',
    },
    {
      name: 'host cannot provide export destination',
      current: 'project-a',
      authorize: unavailable,
      code: 'export_unavailable',
    },
  ]

  for (const denied of deniedCases) {
    test(denied.name + ' without tile read or file creation', async () => {
      const activity = effects()
      await expect(
        attempt(() => denied.current, denied.requested, denied.authorize, activity),
      ).rejects.toMatchObject({ code: denied.code })
      expect(activity.tileReads).toBe(0)
      expect(activity.fileCreations).toBe(0)
      expect(activity.published).toBeNull()
    })
  }

  test('a project switch during asynchronous host authorization cannot stage a file', async () => {
    let active: string | null = 'project-a'
    const activity = effects()
    await expect(
      attempt(
        () => active,
        'project-a',
        () => {
          active = 'project-b'
          return { status: 'authorized', projectId: 'project-a', directory }
        },
        activity,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    expect(activity.tileReads).toBe(0)
    expect(activity.fileCreations).toBe(0)
  })

  test('a grant tied to another project or an invalid destination fails closed', async () => {
    const wrongProject: AuthorizeGigapixelExport = () => ({
      status: 'authorized',
      projectId: 'project-b',
      directory,
    })
    const wrongDestination: AuthorizeGigapixelExport = () => ({
      status: 'authorized',
      projectId: 'project-a',
      directory: null as unknown as FileSystemDirectoryHandle,
    })
    for (const [authorize, code] of [
      [wrongProject, 'permission_denied'],
      [wrongDestination, 'export_unavailable'],
    ] as const) {
      const activity = effects()
      await expect(
        attempt(() => 'project-a', 'project-a', authorize, activity),
      ).rejects.toMatchObject({ code })
      expect(activity.tileReads).toBe(0)
      expect(activity.fileCreations).toBe(0)
    }
  })

  test('a valid host grant binds the destination and permits exactly one staged capture', async () => {
    const activity = effects()
    const stats = await attempt(() => 'project-a', 'project-a', approve, activity)
    // 2x2 / 1px DZI: four max-level tiles, one level-zero tile, one descriptor.
    expect(stats.tilesWritten).toBe(5)
    expect(stats.passes).toBe(1)
    expect(activity.tileReads).toBe(1)
    expect(activity.fileCreations).toBe(1)
    const archive = unzipSync(new Uint8Array(await activity.published!.arrayBuffer()))
    expect(Object.keys(archive)).toHaveLength(6)
  })

  test('a grant cannot be reused after the active project switches', async () => {
    const grant = await requireGigapixelExportAuthority(
      () => 'project-a',
      'project-a',
      approve,
    )
    expect(() =>
      assertGigapixelExportStillActive(grant, () => 'project-b'),
    ).toThrow('permission_denied')
    expect(() => assertGigapixelExportStillActive(grant, () => null)).toThrow('no_project')
  })
})
