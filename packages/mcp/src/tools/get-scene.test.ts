import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { SceneMaterial, WallNode } from '@pascal-app/core/schema'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { registerGetScene } from '@pascal-app/mcp/tools/get-scene'

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

  test('includes scene-owned material definitions needed by a wall finish', async () => {
    const level = Object.values(bridge.getNodes()).find((node) => node.type === 'level')!
    const material = SceneMaterial.parse({
      id: 'mat_timber',
      name: 'Warm timber',
      material: { preset: 'wood', properties: { color: '#71503a', roughness: 0.86, metalness: 0 } },
    })
    const wall = WallNode.parse({
      id: 'wall_finish',
      start: [0, 0],
      end: [3, 0],
      slots: { a: `scene:${material.id}` },
    })
    bridge.createNode(wall, level.id)
    bridge.loadJSON({
      ...bridge.exportJSON(),
      materials: { [material.id]: material },
    })

    const result = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)
    const expected = { [material.id]: material }
    expect(result.structuredContent?.materials).toEqual(expected)
    expect(parsed.materials).toEqual(expected)
    expect(parsed.nodes[wall.id].slots.a).toBe(`scene:${material.id}`)
  })
})
