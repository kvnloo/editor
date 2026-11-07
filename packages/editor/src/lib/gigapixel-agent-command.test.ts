import { describe, expect, test } from 'bun:test'
import { executeGigapixelExport } from '@pascal-app/core/agent-operations'
import { createEditorGigapixelExportHost } from '@pascal-app/editor/gigapixel-editor-executor'
import {
  type GigapixelExportHost,
  runHostedGigapixelExport,
} from '@pascal-app/editor/gigapixel-agent-command'
import { createStagedGigapixelArtifactSink } from '@pascal-app/editor/gigapixel-artifact-sink'
import { streamGigapixelCapture } from '@pascal-app/editor/gigapixel-capture'
import { unzipSync } from 'fflate'

const directory = {
  kind: 'directory',
  getDirectoryHandle: async () => directory,
  getFileHandle: async () => {
    throw new DOMException('File not found', 'NotFoundError')
  },
  removeEntry: async () => {},
} as unknown as FileSystemDirectoryHandle

function hostFor(
  state: { active: string | null; authorizationCalls: number; captures: number; tileReads: number },
  decision: 'grant' | 'deny' | 'unavailable' = 'grant',
): GigapixelExportHost {
  return {
    getActiveProjectId: () => state.active,
    authorizeGigapixelExport(projectId) {
      state.authorizationCalls++
      if (decision !== 'grant') {
        return { status: 'denied', code: decision === 'deny' ? 'permission_denied' : 'export_unavailable' }
      }
      return { status: 'authorized', projectId, directory }
    },
    async exportZip({ grant }) {
      expect(grant.projectId).toBe('project-a')
      expect(grant.directory).toBe(directory)
      state.captures++
      const chunks: Uint8Array[] = []
      const sink = await createStagedGigapixelArtifactSink(
        {
          stage() {
            return {
              write(chunk) {
                chunks.push(chunk.slice())
              },
              publish(name) {
                expect(name).toBe('capture.deepzoom.zip')
              },
              discard() {
                chunks.length = 0
              },
            }
          },
        },
        'capture.deepzoom.zip',
      )
      const stats = await streamGigapixelCapture(
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
          state.tileReads++
          return new Uint8ClampedArray(pass.w * pass.h * 4).fill(255)
        },
        (rgba) => new Uint8Array(rgba),
        sink,
      )
      const entries = Object.keys(unzipSync(new Uint8Array(await new Blob(chunks).arrayBuffer())))
      expect(entries).toHaveLength(6)
      return {
        fileName: 'capture.deepzoom.zip',
        mimeType: 'application/zip' as const,
        ...stats.artifact,
        rollback: () => sink.rollback(),
      }
    },
  }
}

const state = () => ({
  active: 'project-a' as string | null,
  authorizationCalls: 0,
  captures: 0,
  tileReads: 0,
})

describe('hosted command using the shared gigapixel export operation', () => {
  test('missing host is unavailable', async () => {
    await expect(runHostedGigapixelExport({}, undefined)).rejects.toMatchObject({
      code: 'export_unavailable',
    })
  })

  for (const [name, active, decision, code, authorizations] of [
    ['no active project', null, 'grant', 'no_project', 0],
    ['host denied permission', 'project-a', 'deny', 'permission_denied', 1],
    ['host export unavailable', 'project-a', 'unavailable', 'export_unavailable', 1],
    ['different requested project', 'project-a', 'grant', 'permission_denied', 0],
  ] as const) {
    test(name + ' refuses without capturing a tile', async () => {
      const activity = state()
      activity.active = active
      await expect(
        runHostedGigapixelExport(
          { projectId: name === 'different requested project' ? 'project-b' : 'project-a' },
          hostFor(activity, decision),
        ),
      ).rejects.toMatchObject({ code })
      expect(activity.authorizationCalls).toBe(authorizations)
      expect(activity.captures).toBe(0)
      expect(activity.tileReads).toBe(0)
    })
  }

  test('a host without an authorizer cannot capture', async () => {
    const activity = state()
    const host = hostFor(activity)
    delete host.authorizeGigapixelExport
    await expect(runHostedGigapixelExport({}, host)).rejects.toMatchObject({
      code: 'export_unavailable',
    })
    expect(activity.authorizationCalls).toBe(0)
    expect(activity.captures).toBe(0)
    expect(activity.tileReads).toBe(0)
  })

  test('a granted host captures and returns the ZIP receipt', async () => {
    const activity = state()
    const receipt = await runHostedGigapixelExport({}, hostFor(activity))
    expect(receipt).toMatchObject({
      status: 'exported',
      projectId: 'project-a',
      fileName: 'capture.deepzoom.zip',
      mimeType: 'application/zip',
      tileCount: 5,
    })
    expect(receipt.bytes).toBeGreaterThan(0)
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(activity.authorizationCalls).toBe(1)
    expect(activity.captures).toBe(1)
    expect(activity.tileReads).toBe(1)
  })

  test('switching projects during authorization never reaches the renderer', async () => {
    const activity = state()
    const host = hostFor(activity)
    host.authorizeGigapixelExport = (projectId) => {
      activity.authorizationCalls++
      activity.active = 'project-b'
      return { status: 'authorized', projectId, directory }
    }
    await expect(runHostedGigapixelExport({}, host)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(activity.captures).toBe(0)
    expect(activity.tileReads).toBe(0)
  })

  test('invalid inputs are refused before authority or rendering', async () => {
    const activity = state()
    await expect(
      runHostedGigapixelExport({ projectId: 'project-a', directory: 'untrusted' }, hostFor(activity)),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(activity.authorizationCalls).toBe(0)
    expect(activity.captures).toBe(0)
  })
  test('the mounted executor uses one authority and retracts a switched-project ZIP', async () => {
    const activity = state()
    const producer = hostFor(activity)
    const host = createEditorGigapixelExportHost({
      getActiveProjectId: producer.getActiveProjectId,
      authorizeGigapixelExport: producer.authorizeGigapixelExport,
    })
    await expect(runHostedGigapixelExport({}, host)).rejects.toMatchObject({
      code: 'export_unavailable',
    })
    let rollbacks = 0
    const detach = host.attachCapture(async (request) => {
      const result = await producer.exportZip(request)
      if (activity.captures === 3) activity.active = 'project-b'
      return {
        ...result,
        rollback: async () => {
          await result.rollback()
          rollbacks++
        },
      }
    })
    const hosted = await runHostedGigapixelExport({}, host)
    expect(hosted).toEqual(await executeGigapixelExport({}, host))
    expect(hosted).toMatchObject({ status: 'exported', tileCount: 5 })
    expect('rollback' in hosted).toBe(false)
    expect(activity.tileReads).toBe(2)
    await expect(runHostedGigapixelExport({}, host)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(rollbacks).toBe(1)
    expect(activity.captures).toBe(3)
    detach()
    activity.active = 'project-a'
    await expect(runHostedGigapixelExport({}, host)).rejects.toMatchObject({
      code: 'export_unavailable',
    })
    expect(activity.captures).toBe(3)
  })

})
