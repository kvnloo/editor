import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Client,
  type ClientOptions,
  InMemoryTransport,
  SdkErrorCode,
} from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  captureRegistryVersions,
  type DetachedScene,
  effectIds,
  openDetachedScene,
} from '@pascal-app/core/runtime'
import { type AnyNode, WallNode } from '@pascal-app/core/schema'
import { SceneBridge } from '../bridge/scene-bridge'
import { createPascalMcpServer } from '../server'
import { connectStdio } from './stdio'

const MODERN = '2026-07-28'

const clients: Record<string, ClientOptions> = {
  'an older client (2025 initialize)': {},
  'a negotiating client': { versionNegotiation: { mode: 'auto' } },
  [`a client pinned to ${MODERN}`]: { versionNegotiation: { mode: { pin: MODERN } } },
}

function createTestServers() {
  const scenes: DetachedScene[] = []
  return {
    createServer() {
      const scene = openDetachedScene(
        { nodes: {}, rootNodeIds: [], collections: {}, materials: {}, installedPlugins: [] },
        {
          base: { kind: 'authority', seq: 0 },
          context: {
            activeLevelId: null,
            selection: [],
            units: 'metric',
            catalogVersion: 'stdio-test',
            registryVersions: captureRegistryVersions(),
          },
          ids: effectIds(`stdio-test-${scenes.length}`),
        },
      )
      try {
        const bridge = new SceneBridge({ runtime: scene })
        bridge.loadDefault()
        const server = createPascalMcpServer({ bridge })
        scenes.push(scene)
        return server
      } catch (error) {
        scene.dispose()
        throw error
      }
    },
    dispose() {
      for (const scene of scenes) scene.dispose()
    },
  }
}

async function openTestClient(options: ClientOptions) {
  const servers = createTestServers()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const handle = connectStdio(servers.createServer, { transport: serverTransport })
  const client = new Client({ name: 'stdio-test-client', version: '0.0.0' }, options)
  const close = async () => {
    try {
      await client.close()
    } finally {
      try {
        await handle.close()
      } finally {
        servers.dispose()
      }
    }
  }
  try {
    await client.connect(clientTransport)
  } catch (error) {
    await close()
    throw error
  }
  return { client, close }
}

async function expectServed(client: Client, options: ClientOptions) {
  const modern = options.versionNegotiation !== undefined
  expect(client.getProtocolEra()).toBe(modern ? 'modern' : 'legacy')
  if (modern) expect(client.getNegotiatedProtocolVersion()).toBe(MODERN)
  else expect(client.getNegotiatedProtocolVersion()?.startsWith('2025-')).toBe(true)

  const { tools } = await client.listTools()
  expect(tools.some((tool) => tool.name === 'get_scene')).toBe(true)
  const scene = await client.callTool({ name: 'get_scene', arguments: {} })
  expect(scene.isError).toBeFalsy()
}

describe('connectStdio', () => {
  for (const [who, options] of Object.entries(clients)) {
    test(`serves ${who}`, async () => {
      const connection = await openTestClient(options)
      try {
        await expectServed(connection.client, options)
      } finally {
        await connection.close()
      }
    })
  }

  test(`keeps one scene for the whole connection on ${MODERN}`, async () => {
    const connection = await openTestClient({ versionNegotiation: { mode: { pin: MODERN } } })
    try {
      const { structuredContent } = await connection.client.callTool({
        name: 'get_scene',
        arguments: {},
      })
      const nodes = Object.values((structuredContent as { nodes: Record<string, AnyNode> }).nodes)
      const level = nodes.find((node) => node.type === 'level')!
      const wall = WallNode.parse({ start: [0, 0], end: [4, 0] })
      const created = await connection.client.callTool({
        name: 'apply_patch',
        arguments: { patches: [{ op: 'create', node: wall, parentId: level.id }] },
      })
      expect(created.isError).toBeFalsy()
      const after = await connection.client.callTool({ name: 'get_scene', arguments: {} })
      expect(Object.keys((after.structuredContent as { nodes: object }).nodes)).toContain(wall.id)
    } finally {
      await connection.close()
    }
  })

  test(`opening another ${MODERN} connection leaves the first scene intact`, async () => {
    const first = await openTestClient({ versionNegotiation: { mode: { pin: MODERN } } })
    let second: Awaited<ReturnType<typeof openTestClient>> | undefined
    try {
      const before = await first.client.callTool({ name: 'get_scene', arguments: {} })
      expect(before.isError).toBeFalsy()
      const initialNodes = (before.structuredContent as { nodes: Record<string, AnyNode> }).nodes
      expect(Object.keys(initialNodes)).toHaveLength(3)
      const level = Object.values(initialNodes).find((node) => node.type === 'level')
      if (!level) throw new Error('default level missing')

      const wall = WallNode.parse({ start: [0, 0], end: [4, 0] })
      const created = await first.client.callTool({
        name: 'apply_patch',
        arguments: { patches: [{ op: 'create', node: wall, parentId: level.id }] },
      })
      expect(created.isError).toBeFalsy()

      second = await openTestClient({ versionNegotiation: { mode: { pin: MODERN } } })
      const [firstAfter, secondAfter] = await Promise.all([
        first.client.callTool({ name: 'get_scene', arguments: {} }),
        second.client.callTool({ name: 'get_scene', arguments: {} }),
      ])
      expect(firstAfter.isError).toBeFalsy()
      expect(secondAfter.isError).toBeFalsy()
      const retained = (firstAfter.structuredContent as { nodes: Record<string, AnyNode> }).nodes
      const fresh = (secondAfter.structuredContent as { nodes: Record<string, AnyNode> }).nodes
      expect(retained[wall.id]).toBeDefined()
      expect(Object.keys(fresh)).toHaveLength(3)
      expect(fresh[wall.id]).toBeUndefined()
    } finally {
      try {
        if (second) await second.close()
      } finally {
        await first.close()
      }
    }
  })

  test(`a server connected to the transport by hand fails a ${MODERN} client`, async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const servers = createTestServers()
    const server = servers.createServer()
    const client = new Client(
      { name: 'stdio-test-client', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN } } },
    )
    try {
      await server.connect(serverTransport)
      await expect(client.connect(clientTransport)).rejects.toMatchObject({
        code: SdkErrorCode.EraNegotiationFailed,
      })
    } finally {
      try {
        await client.close()
      } finally {
        try {
          await server.close()
        } finally {
          servers.dispose()
        }
      }
    }
  })
})

describe('pascal-mcp --stdio', () => {
  const bin = fileURLToPath(new URL('../bin/pascal-mcp.ts', import.meta.url))
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pascal-mcp-stdio-'))
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  for (const [who, options] of Object.entries(clients)) {
    test(`serves ${who}`, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bin, '--stdio'],
        env: { ...getDefaultEnvironment(), PASCAL_DATA_DIR: dataDir },
        stderr: 'ignore',
      })
      const client = new Client({ name: 'stdio-process-test-client', version: '0.0.0' }, options)
      try {
        await client.connect(transport)
        await expectServed(client, options)
      } finally {
        await client.close()
      }
    }, 30_000)
  }
})
