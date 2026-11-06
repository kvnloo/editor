import { beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SiteNode } from '@pascal-app/core/schema'
import useScene from '@pascal-app/core/store'
import { SceneBridge } from '@pascal-app/mcp/bridge'
import { createSceneOperations } from '@pascal-app/mcp/operations'
import { registerApplyPatch } from '@pascal-app/mcp/tools/apply-patch'
import { registerValidateScene } from '@pascal-app/mcp/tools/validate-scene'

const a = SiteNode.parse({ id: 'site_a' })
const b = SiteNode.parse({ id: 'site_b' })
const c = SiteNode.parse({ id: 'site_c' })

function snapshot() {
  const { nodes, rootNodeIds } = useScene.getState()
  return structuredClone({ nodes, rootNodeIds })
}

function seed(nodes: Record<string, typeof a>, roots: string[]) {
  useScene.setState({ nodes, rootNodeIds: roots } as never)
  useScene.temporal.getState().clear()
}

describe('atomic reparent through package exports', () => {
  beforeEach(() => {
    seed({ [a.id]: a, [b.id]: b }, [a.id, b.id])
  })

  test('three-node cycle and self-parent reject through updateNode and updateNodes', () => {
    seed({
      [a.id]: SiteNode.parse({ id: a.id, children: [b.id] }),
      [b.id]: SiteNode.parse({ id: b.id, parentId: a.id, children: [c.id] }),
      [c.id]: SiteNode.parse({ id: c.id, parentId: b.id }),
    }, [a.id])
    const before = snapshot()
    expect(() => useScene.getState().updateNode(a.id, { parentId: c.id })).toThrow()
    expect(snapshot()).toEqual(before)
    expect(() => useScene.getState().updateNodes([
      { id: a.id, data: { parentId: c.id } },
    ])).toThrow()
    expect(snapshot()).toEqual(before)
    expect(() => useScene.getState().updateNode(a.id, { parentId: a.id })).toThrow()
    expect(snapshot()).toEqual(before)
  })

  test('two-root A/B batch refuses atomically, including undo history', () => {
    const before = snapshot()
    const undo = structuredClone(useScene.temporal.getState().pastStates)
    expect(() => useScene.getState().updateNodes([
      { id: a.id, data: { parentId: b.id } },
      { id: b.id, data: { parentId: a.id } },
    ])).toThrow()
    expect(snapshot()).toEqual(before)
    expect(useScene.temporal.getState().pastStates).toEqual(undo)
  })

  test('MCP second operation refuses at index 1; imported cycle validates invalid', async () => {
    const bridge = new SceneBridge()
    bridge.setScene({ [a.id]: a, [b.id]: b }, [a.id, b.id])
    const server = new McpServer({ name: 'atomic-test', version: '1.0.0' })
    registerApplyPatch(server, createSceneOperations({ bridge }))
    registerValidateScene(server, createSceneOperations({ bridge }))
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'atomic-client', version: '1.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const before = structuredClone({ nodes: bridge.getNodes(), roots: bridge.getRootNodeIds() })
      const result = await client.callTool({
        name: 'apply_patch',
        arguments: { patches: [
          { op: 'update', id: a.id, data: { parentId: b.id } },
          { op: 'update', id: b.id, data: { parentId: a.id } },
        ] },
      })
      expect(result.isError).toBe(true)
      const refusal = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      expect(refusal).toMatchObject({ code: 'invalid_parent', patchIndex: 1, id: b.id })
      expect({ nodes: bridge.getNodes(), roots: bridge.getRootNodeIds() }).toEqual(before)

      bridge.setScene({
        [a.id]: SiteNode.parse({ id: a.id, parentId: b.id, children: [b.id] }),
        [b.id]: SiteNode.parse({ id: b.id, parentId: a.id, children: [a.id] }),
      }, [])
      const validation = await client.callTool({ name: 'validate_scene', arguments: {} })
      const report = validation.structuredContent as {
        valid: boolean
        errors: Array<{ nodeId: string; path: string }>
      }
      expect(report.valid).toBe(false)
      expect(report.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: a.id, path: 'parentId' }),
        expect.objectContaining({ nodeId: b.id, path: 'parentId' }),
      ]))
    } finally {
      await client.close()
      await server.close()
    }
  })
})
