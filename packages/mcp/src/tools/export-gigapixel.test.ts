import { describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { SceneBridge } from '@pascal-app/mcp'
import { createPascalMcpServer } from '@pascal-app/mcp/server'
import type { GigapixelExportHost } from '@pascal-app/core/agent-operations'

const directory = {
  kind: 'directory',
  getDirectoryHandle: async () => directory,
  getFileHandle: async () => {
    throw new DOMException('File not found', 'NotFoundError')
  },
  removeEntry: async () => {},
} as unknown as FileSystemDirectoryHandle

interface Counts {
  grants: number
  captures: number
}

function authorizedHost(counts: Counts, allowed: boolean): GigapixelExportHost {
  return {
    getActiveProjectId: () => 'project-a',
    authorizeGigapixelExport(projectId) {
      counts.grants++
      return allowed
        ? { status: 'authorized', projectId, directory }
        : { status: 'denied', code: 'permission_denied' }
    },
    async exportZip({ grant }) {
      counts.captures++
      expect(grant).toMatchObject({ projectId: 'project-a', directory })
      return {
        fileName: 'capture.deepzoom.zip',
        mimeType: 'application/zip',
        bytes: 864,
        sha256: 'a'.repeat(64),
        tileCount: 5,
      }
    },
  }
}

async function viaMcp(
  host: GigapixelExportHost | undefined,
  input: Record<string, unknown> = {},
) {
  const server = createPascalMcpServer({
    bridge: new SceneBridge(),
    gigapixelExports: host,
  })
  const client = new Client({ name: 'gigapixel-export-test', version: '1' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    const result = await client.callTool({ name: 'export_gigapixel', arguments: input })
    return {
      isError: Boolean(result.isError),
      payload: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<
        string,
        unknown
      >,
    }
  } finally {
    await client.close()
    await server.close()
  }
}

describe('gigapixel ZIP export through a real MCP client', () => {
  test('no editor export host fails closed', async () => {
    expect(await viaMcp(undefined)).toMatchObject({
      isError: true,
      payload: { code: 'export_unavailable' },
    })
  })

  test('no host authorizer is not permission to write', async () => {
    const counts = { grants: 0, captures: 0 }
    const host = authorizedHost(counts, true)
    delete host.authorizeGigapixelExport
    expect(await viaMcp(host)).toMatchObject({
      isError: true,
      payload: { code: 'export_unavailable' },
    })
    expect(counts).toEqual({ grants: 0, captures: 0 })
  })

  test('denied permission never creates an export', async () => {
    const counts = { grants: 0, captures: 0 }
    expect(await viaMcp(authorizedHost(counts, false))).toMatchObject({
      isError: true,
      payload: { code: 'permission_denied' },
    })
    expect(counts).toEqual({ grants: 1, captures: 0 })
  })

  test('wrong project never reaches the host authorizer', async () => {
    const counts = { grants: 0, captures: 0 }
    expect(await viaMcp(authorizedHost(counts, true), { projectId: 'project-b' })).toMatchObject({
      isError: true,
      payload: { code: 'permission_denied' },
    })
    expect(counts).toEqual({ grants: 0, captures: 0 })
  })

  test('the granted project produces the shared export receipt', async () => {
    const counts = { grants: 0, captures: 0 }
    const result = await viaMcp(authorizedHost(counts, true), { projectId: 'project-a' })
    expect(result.isError).toBe(false)
    expect(result.payload).toMatchObject({
      status: 'exported',
      projectId: 'project-a',
      fileName: 'capture.deepzoom.zip',
      mimeType: 'application/zip',
      bytes: 864,
      sha256: 'a'.repeat(64),
      tileCount: 5,
    })
    expect(counts).toEqual({ grants: 1, captures: 1 })
  })
})
