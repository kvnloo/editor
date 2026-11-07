import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import {
  type AnyNodeDefinition,
  isNodeKindEnabled,
  loadPlugin,
  type NodeDefinition,
  nodeRegistry,
} from '@pascal-app/core'
import { type AnyNode, BaseNode, nodeType, objectId } from '@pascal-app/core/schema'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { registerGetScene } from '@pascal-app/mcp/tools/get-scene'
import { z } from 'zod'

const PLUGIN_ID = 'fixture:get-scene-install'
const PLUGIN_KIND = 'fixture:get-scene-node'
const FixtureNode = BaseNode.extend({
  id: objectId('fxgetscene'),
  type: nodeType(PLUGIN_KIND),
  value: z.number().default(1),
})
const fixtureDefinition: NodeDefinition<typeof FixtureNode> = {
  kind: PLUGIN_KIND,
  schemaVersion: 1,
  schema: FixtureNode,
  category: 'utility',
  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    value: 1,
  }),
  capabilities: {},
}
type ListedScene = {
  nodes: Record<string, unknown>
  installedPlugins?: string[]
}

describe('get_scene', () => {
  let client: Client
  let bridge: SceneBridge

  beforeEach(async () => {
    bridge = new SceneBridge()
    bridge.setScene({}, [])
    bridge.loadDefault()
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerGetScene(server, bridge)
    const [srvT, cliT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(srvT), client.connect(cliT)])
  })

  test('returns scene with nodes and rootNodeIds', async () => {
    const result = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    const parsed = JSON.parse(text)
    expect(Array.isArray(parsed.rootNodeIds)).toBe(true)
    expect(parsed.rootNodeIds.length).toBeGreaterThan(0)
    expect(typeof parsed.nodes).toBe('object')
    expect(Object.keys(parsed.nodes).length).toBeGreaterThan(0)
  })

  test('reflects mutations to the bridge', async () => {
    const beforeCount = Object.keys(bridge.getNodes()).length
    bridge.setScene({}, [])
    const result = await client.callTool({ name: 'get_scene', arguments: {} })
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    expect(parsed.rootNodeIds.length).toBe(0)
    expect(Object.keys(parsed.nodes).length).toBe(0)
    expect(beforeCount).toBeGreaterThan(0)
  })

  test('returns structured content', async () => {
    const result = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(result.structuredContent).toBeDefined()
    expect(
      Array.isArray((result.structuredContent as { rootNodeIds: unknown[] }).rootNodeIds),
    ).toBe(true)
  })

  test('returns explicit installed plugin IDs so an agent can discover its service context', async () => {
    bridge.loadJSON({ ...bridge.exportJSON(), installedPlugins: ['pascal:architect'] })
    const result = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(result.structuredContent?.installedPlugins).toEqual(['pascal:architect'])
    const legacy = bridge.exportJSON()
    delete legacy.installedPlugins
    bridge.loadJSON(legacy)
    const withoutInstallState = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(withoutInstallState.structuredContent).not.toHaveProperty('installedPlugins')
  })

  test('registered but uninstalled nodes stay serialized and listed, not render-enabled', async () => {
    const restoreRegistry = nodeRegistry._snapshot()
    try {
      await loadPlugin({
        id: PLUGIN_ID,
        apiVersion: 1,
        nodes: [fixtureDefinition as unknown as AnyNodeDefinition],
      })
      const level = bridge.findNodes({ type: 'level' })[0]!
      bridge.loadJSON({ ...bridge.exportJSON(), installedPlugins: [] })
      const node = FixtureNode.parse({ value: 7 })
      const created = bridge.applyPatch([
        { op: 'create', node: node as unknown as AnyNode, parentId: level.id },
      ])

      const saved = bridge.exportJSON()
      const response = await client.callTool({ name: 'get_scene', arguments: {} })
      const listed = response.structuredContent as ListedScene | undefined

      // The viewer's public install gate is false, while save and MCP keep the data.
      expect({
        created: created.createdIds.includes(node.id),
        registered: nodeRegistry.has(PLUGIN_KIND),
        renderEnabled: isNodeKindEnabled(PLUGIN_KIND, saved.installedPlugins),
        savedNode: saved.nodes[node.id],
        savedInstalls: saved.installedPlugins,
        listedNode: listed?.nodes[node.id],
        listedInstalls: listed?.installedPlugins,
        valid: bridge.validateScene().valid,
        mcpError: response.isError ?? false,
      }).toEqual({
        created: true,
        registered: true,
        renderEnabled: false,
        savedNode: expect.objectContaining({ type: PLUGIN_KIND, value: 7, parentId: level.id }),
        savedInstalls: [],
        listedNode: expect.objectContaining({ type: PLUGIN_KIND, value: 7, parentId: level.id }),
        listedInstalls: [],
        valid: true,
        mcpError: false,
      })
    } finally {
      restoreRegistry()
    }
  })

  test('installed plugin nodes survive missing registration on reload and MCP listing', async () => {
    const restoreRegistry = nodeRegistry._snapshot()
    try {
      await loadPlugin({
        id: PLUGIN_ID,
        apiVersion: 1,
        nodes: [fixtureDefinition as unknown as AnyNodeDefinition],
      })
      const level = bridge.findNodes({ type: 'level' })[0]!
      bridge.loadJSON({ ...bridge.exportJSON(), installedPlugins: [PLUGIN_ID] })
      const node = FixtureNode.parse({ value: 11 })
      bridge.applyPatch([{ op: 'create', node: node as unknown as AnyNode, parentId: level.id }])
      const installedWasEnabled = isNodeKindEnabled(PLUGIN_KIND, [PLUGIN_ID])
      const before = bridge.exportJSON()

      // Registration is add-only in production. The test-only reset models a later
      // session where persisted plugin data exists but its definition was not loaded.
      nodeRegistry._reset()
      bridge.loadJSON(before)
      const saved = bridge.exportJSON()
      const response = await client.callTool({ name: 'get_scene', arguments: {} })
      const listed = response.structuredContent as ListedScene | undefined
      const unknownNodeReported = bridge
        .validateScene()
        .errors.some((error) => error.nodeId === node.id)

      expect({
        installedWasEnabled,
        registeredAfterReload: nodeRegistry.has(PLUGIN_KIND),
        savedNode: saved.nodes[node.id],
        savedInstalls: saved.installedPlugins,
        listedNode: listed?.nodes[node.id],
        listedInstalls: listed?.installedPlugins,
        unknownNodeReported,
        mcpError: response.isError ?? false,
      }).toEqual({
        installedWasEnabled: true,
        registeredAfterReload: false,
        savedNode: expect.objectContaining({ type: PLUGIN_KIND, value: 11, parentId: level.id }),
        savedInstalls: [PLUGIN_ID],
        listedNode: expect.objectContaining({ type: PLUGIN_KIND, value: 11, parentId: level.id }),
        listedInstalls: [PLUGIN_ID],
        unknownNodeReported: true,
        mcpError: false,
      })
    } finally {
      restoreRegistry()
    }
  })
})
