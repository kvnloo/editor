import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import {
  type AnyNodeDefinition,
  isNodeKindEnabled,
  loadPlugin,
  nodeRegistry,
  type SceneCommit,
  subscribeSceneCommits,
} from '@pascal-app/core'
import {
  applyPatchWithDependencies,
  captureRegistryVersions,
  effectIds,
  openDetachedScene,
  SceneEnvironmentDisposedError,
  type SceneSnapshot,
} from '@pascal-app/core/runtime'
import {
  type AnyNode,
  type AnyNodeId,
  BaseNode,
  BuildingNode,
  GeometryArtifactManifest,
  ItemNode,
  LevelNode,
  nodeType,
  objectId,
  RoofNode,
  WallNode,
} from '@pascal-app/core/schema'
import { createPascalMcpServer, SceneBridge } from '@pascal-app/mcp'
import { z } from 'zod'
import { createSceneOperations, type SceneOperations } from '../operations'
import { SqliteSceneStore } from '../storage/sqlite-scene-store'
import type { GeometryScriptHost } from '../tools/add-object'
import { registerSharedTools } from '../tools/shared-tools'

function snapshot(): SceneSnapshot {
  const level = LevelNode.parse({ id: 'level_g', parentId: 'building_b', level: 0, height: 2.8 })
  const building = BuildingNode.parse({ id: 'building_b', children: [level.id] })
  return {
    nodes: Object.fromEntries([building, level].map((node) => [node.id, node])) as Record<
      AnyNode['id'],
      AnyNode
    >,
    rootNodeIds: [building.id],
    collections: {},
    materials: {},
    installedPlugins: [],
  } as SceneSnapshot
}

function detached(effectId: string, from: SceneSnapshot = snapshot()) {
  return openDetachedScene(from, {
    base: { kind: 'authority', seq: 1 },
    context: {
      activeLevelId: 'level_g',
      selection: [],
      units: 'metric',
      catalogVersion: 'test',
      registryVersions: captureRegistryVersions(),
    },
    ids: effectIds(effectId),
  })
}

async function connect(server: ReturnType<typeof createPascalMcpServer>) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function addWallDetached(effectId: string) {
  const scene = openDetachedScene(snapshot(), {
    base: { kind: 'authority', seq: 1 },
    context: {
      activeLevelId: 'level_g',
      selection: [],
      units: 'metric',
      catalogVersion: 'test',
      registryVersions: captureRegistryVersions(),
    },
    ids: effectIds(effectId),
  })
  const bridge = new SceneBridge({ runtime: scene })
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerSharedTools(server, bridge)
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const result = await client.callTool({
    name: 'add_wall',
    arguments: { levelId: 'level_g', start: [0, 0], end: [4, 0] },
  })
  return { scene, bridge, result }
}

describe('SceneBridge over a detached scene', () => {
  test('a shared tool computes on the detached scene, with its ids and reads, and leaves the editor alone', async () => {
    const editor = new SceneBridge()
    const editorBefore = editor.exportJSON()
    const { scene, bridge, result } = await addWallDetached('effect_wall')
    expect(result.isError).toBeFalsy()

    const patch = scene.patch()
    const walls = patch.nodeCreates.filter(({ node }) => node.type === 'wall')
    expect(walls).toHaveLength(1)
    expect(bridge.getNode(walls[0]!.node.id)).not.toBeNull()
    expect(editor.exportJSON()).toEqual(editorBefore)
    // The default name counts the walls: that selection is a dependency.
    expect(scene.dependencies()).toContainEqual(
      expect.objectContaining({ kind: 'query', entity: 'node', predicate: { type: 'wall' } }),
    )

    // The same effect recomputed mints the same ids.
    const again = await addWallDetached('effect_wall')
    expect(again.scene.patch()).toEqual(patch)

    scene.dispose()
    expect(() => bridge.getNodes()).toThrow(SceneEnvironmentDisposedError)
    expect(() => bridge.updateNode(walls[0]!.node.id, { name: 'Late' })).toThrow(
      SceneEnvironmentDisposedError,
    )
    again.scene.dispose()
  })

  test('plugin scene state stays isolated across detached MCP clients and disposal', async () => {
    const restoreRegistry = nodeRegistry._snapshot()
    const pluginId = 'fixture:detached-parity'
    const kind = 'fixture:detached-probe'
    const PluginProbe = BaseNode.extend({
      id: objectId('detachedprobe'),
      type: nodeType(kind),
      value: z.number().default(1),
    })
    let first: ReturnType<typeof detached> | undefined
    let second: ReturnType<typeof detached> | undefined
    let firstClient: Client | undefined
    let secondClient: Client | undefined

    try {
      await loadPlugin({
        id: pluginId,
        apiVersion: 1,
        nodes: [
          {
            kind,
            schemaVersion: 1,
            schema: PluginProbe,
            category: 'utility',
            defaults: () => ({
              object: 'node',
              parentId: null,
              visible: true,
              metadata: {},
              value: 1,
            }),
            capabilities: {},
          } as unknown as AnyNodeDefinition,
        ],
      })

      const editor = new SceneBridge()
      const editorBefore = editor.exportJSON()
      first = detached('plugin_first', {
        ...snapshot(),
        installedPlugins: [pluginId],
        hasExplicitPluginInstallState: true,
      })
      second = detached('plugin_second', {
        ...snapshot(),
        installedPlugins: [],
        hasExplicitPluginInstallState: true,
      })
      const firstBridge = new SceneBridge({ runtime: first })
      const secondBridge = new SceneBridge({ runtime: second })
      firstClient = await connect(createPascalMcpServer({ bridge: firstBridge }))
      secondClient = await connect(createPascalMcpServer({ bridge: secondBridge }))

      const secondBefore = secondBridge.exportJSON()
      const versionsBefore = captureRegistryVersions()
      const toolsBefore = (await secondClient.listTools()).tools.map((tool) => tool.name)
      const secondWireBefore = await secondClient.callTool({ name: 'get_scene', arguments: {} })
      expect(Object.keys(secondBefore.nodes)).toHaveLength(2)
      expect(secondBefore.installedPlugins).toEqual([])
      expect(isNodeKindEnabled(kind, secondBefore.installedPlugins)).toBe(false)

      const probe = PluginProbe.parse({ id: 'detachedprobe_first', value: 7 })
      const created = await firstClient.callTool({
        name: 'apply_patch',
        arguments: { patches: [{ op: 'create', node: probe, parentId: 'level_g' }] },
      })
      expect(created.isError).toBeFalsy()
      expect(firstBridge.getNode(probe.id as AnyNodeId)).toMatchObject({
        type: kind,
        value: 7,
        parentId: 'level_g',
      })
      expect(firstBridge.validateScene().valid).toBe(true)

      const firstWire = await firstClient.callTool({ name: 'get_scene', arguments: {} })
      const firstData = firstWire.structuredContent as {
        nodes: Record<string, unknown>
        installedPlugins?: string[]
      }
      expect(Object.keys(firstData.nodes)).toHaveLength(3)
      expect(firstData.nodes[probe.id]).toMatchObject({ type: kind, value: 7 })
      expect(firstData.installedPlugins).toEqual([pluginId])
      expect(isNodeKindEnabled(kind, firstData.installedPlugins)).toBe(true)

      const secondWire = await secondClient.callTool({ name: 'get_scene', arguments: {} })
      expect(secondWire.structuredContent).toEqual(secondWireBefore.structuredContent)
      expect((await secondClient.listTools()).tools.map((tool) => tool.name)).toEqual(toolsBefore)
      expect(secondBridge.exportJSON()).toEqual(secondBefore)
      expect(editor.exportJSON()).toEqual(editorBefore)

      first.dispose()
      expect(() => firstBridge.getNodes()).toThrow(SceneEnvironmentDisposedError)
      expect(captureRegistryVersions()).toEqual(versionsBefore)
      expect(nodeRegistry.has(kind)).toBe(true)
      expect(secondBridge.exportJSON()).toEqual(secondBefore)
      expect(secondBridge.validateScene()).toEqual({ valid: true, errors: [], warnings: [] })
      const afterDispose = await secondClient.callTool({ name: 'get_scene', arguments: {} })
      expect(afterDispose.structuredContent).toEqual(secondWireBefore.structuredContent)
      expect((await secondClient.listTools()).tools.map((tool) => tool.name)).toEqual(toolsBefore)
      expect(isNodeKindEnabled(kind, secondBridge.exportJSON().installedPlugins)).toBe(false)
      expect(editor.exportJSON()).toEqual(editorBefore)
    } finally {
      first?.dispose()
      second?.dispose()
      restoreRegistry()
      await Promise.all([firstClient?.close(), secondClient?.close()])
    }
  })

  for (const scenario of [
    {
      action: 'detach',
      expectedIds: ['building_other', 'level_other'],
      expectedAncestry: [] as string[],
      retained: false,
    },
    {
      action: 'reparent',
      expectedIds: [
        'building_b',
        'level_g',
        'building_other',
        'level_other',
        'ancestryprobe_child',
      ],
      expectedAncestry: ['ancestryprobe_child', 'level_g', 'building_other'],
      retained: true,
    },
    {
      action: 'delete',
      expectedIds: ['building_other', 'level_other'],
      expectedAncestry: [] as string[],
      retained: false,
    },
  ] as const) {
    test('nested plugin validation follows the parent subtree on ' + scenario.action, async () => {
      const restoreRegistry = nodeRegistry._snapshot()
      const pluginId = 'fixture:ancestry'
      const kind = 'fixture:ancestry-probe'
      const AncestryProbe = BaseNode.extend({
        id: objectId('ancestryprobe'),
        type: nodeType(kind),
        value: z.number().default(1),
      })
      let beforeScene: ReturnType<typeof detached> | undefined
      let afterScene: ReturnType<typeof detached> | undefined
      let afterClient: Client | undefined

      try {
        await loadPlugin({
          id: pluginId,
          apiVersion: 1,
          nodes: [
            {
              kind,
              schemaVersion: 1,
              schema: AncestryProbe,
              category: 'utility',
              defaults: () => ({
                object: 'node',
                parentId: null,
                visible: true,
                metadata: {},
                value: 1,
              }),
              capabilities: {},
            } as unknown as AnyNodeDefinition,
          ],
        })

        const base = snapshot()
        const building = base.nodes['building_b' as AnyNodeId] as BuildingNode
        const level = base.nodes['level_g' as AnyNodeId] as LevelNode
        const probe = AncestryProbe.parse({
          id: 'ancestryprobe_child',
          parentId: level.id,
          value: 7,
        })
        const otherLevel = LevelNode.parse({
          id: 'level_other',
          parentId: 'building_other',
          level: 0,
          height: 2.8,
        })
        const otherBuilding = BuildingNode.parse({
          id: 'building_other',
          children: [otherLevel.id],
        })
        beforeScene = detached('ancestry_before_' + scenario.action, {
          ...base,
          nodes: {
            ...base.nodes,
            [level.id]: { ...level, children: [probe.id] },
            [probe.id]: probe as unknown as AnyNode,
            [otherBuilding.id]: otherBuilding,
            [otherLevel.id]: otherLevel,
          },
          rootNodeIds: [building.id, otherBuilding.id],
          installedPlugins: [pluginId],
          hasExplicitPluginInstallState: true,
        } as SceneSnapshot)
        const beforeBridge = new SceneBridge({ runtime: beforeScene })
        const before = beforeBridge.exportJSON()
        expect(Object.keys(before.nodes)).toHaveLength(5)
        expect(before.installedPlugins).toEqual([pluginId])
        expect(isNodeKindEnabled(kind, before.installedPlugins)).toBe(true)
        expect(beforeBridge.getAncestry(probe.id as AnyNodeId).map((node) => node.id)).toEqual([
          probe.id,
          level.id,
          building.id,
        ])
        expect(beforeBridge.validateScene()).toEqual({ valid: true, errors: [], warnings: [] })

        if (scenario.action === 'detach') {
          // Saved document no longer roots the first building: its entire subtree is pruned.
          beforeBridge.loadJSON({ ...before, rootNodeIds: [otherBuilding.id] })
        } else if (scenario.action === 'reparent') {
          // Move the parent, not the plugin leaf, and keep the same project install list.
          beforeBridge.updateNode(level.id, { parentId: otherBuilding.id })
        } else {
          expect(beforeBridge.deleteNode(building.id, true)).toEqual(
            expect.arrayContaining([building.id, level.id, probe.id]),
          )
        }

        const persisted = beforeBridge.exportJSON()
        beforeScene.dispose()
        beforeScene = undefined
        // Simulate a later session that loads the saved scene but not its plugin code.
        nodeRegistry._reset()
        afterScene = detached('ancestry_after_' + scenario.action, {
          ...persisted,
          hasExplicitPluginInstallState: true,
        } as SceneSnapshot)
        const afterBridge = new SceneBridge({ runtime: afterScene })
        afterClient = await connect(createPascalMcpServer({ bridge: afterBridge }))
        const wire = await afterClient.callTool({ name: 'get_scene', arguments: {} })
        const listed = wire.structuredContent as {
          nodes: Record<string, unknown>
          installedPlugins?: string[]
        }
        const after = afterBridge.exportJSON()
        const validation = afterBridge.validateScene()

        expect(wire.isError).toBeFalsy()
        expect(Object.keys(after.nodes).sort()).toEqual([...scenario.expectedIds].sort())
        expect(Object.keys(listed.nodes).sort()).toEqual([...scenario.expectedIds].sort())
        expect(afterBridge.getAncestry(probe.id as AnyNodeId).map((node) => node.id)).toEqual(
          scenario.expectedAncestry,
        )
        expect(after.installedPlugins).toEqual([pluginId])
        expect(listed.installedPlugins).toEqual([pluginId])
        expect(nodeRegistry.has(kind)).toBe(false)
        expect(after.nodes[probe.id] !== undefined).toBe(scenario.retained)
        expect(listed.nodes[probe.id] !== undefined).toBe(scenario.retained)
        expect(validation.valid).toBe(!scenario.retained)
        expect(validation.errors.some((error) => error.nodeId === probe.id)).toBe(
          scenario.retained,
        )
      } finally {
        await afterClient?.close()
        beforeScene?.dispose()
        afterScene?.dispose()
        restoreRegistry()
      }
    })
  }

})

describe('every MCP tool on a detached scene', () => {
  const compiledBox = {
    sha256: 'a'.repeat(64),
    script: 'b'.repeat(64),
    mount: 'floor' as const,
    params: {},
    manifest: GeometryArtifactManifest.parse({
      bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      triangles: 12,
    }),
  }
  const host: GeometryScriptHost = {
    compile: async () => ({ ...compiledBox, glb: new Uint8Array() }) as never,
    storeArtifact: async ({ sha256 }) => sha256,
    readArtifact: async () => null,
  }

  async function build(effectId: string) {
    const base = snapshot()
    const wall = WallNode.parse({
      id: 'wall_g',
      parentId: 'level_g',
      start: [0, 0],
      end: [6, 0],
      height: 2.8,
    })
    const level = base.nodes['level_g' as AnyNodeId] as LevelNode
    const scene = detached(effectId, {
      ...base,
      nodes: { ...base.nodes, [wall.id]: wall, [level.id]: { ...level, children: [wall.id] } },
    } as SceneSnapshot)
    const bridge = new SceneBridge({ runtime: scene })
    bridge.setActiveScene({ id: 'scene_detached', name: 'Detached' } as never)
    bridge.agentSession.keep({
      designBrief: {
        fixed: ['the test’s pieces'],
        open: [],
        source: 'catalog',
        vision: 'The catalog as it is.',
        beyond: 'none: the test places what the request names.',
      },
    })
    const client = await connect(createPascalMcpServer({ bridge, geometryScripts: host }))
    const calls = [
      ['create_unit', { buildingId: 'building_b', name: 'Flat' }],
      ['create_roof', { levelId: 'level_g', width: 6, depth: 4 }],
      ['add_column', { levelId: 'level_g', x: 1, z: 1 }],
      // These await their (absent) compile before planning.
      ['add_door', { wallId: 'wall_g', t: 0.25 }],
      ['add_window', { wallId: 'wall_g', t: 0.7 }],
      [
        'add_object',
        {
          code: 'export default function build() {}',
          levelId: 'level_g',
          name: 'Planter',
          reason: 'No planter type.',
          x: 2,
          z: 2,
        },
      ],
    ] as const
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy()
    }
    const patch = scene.patch()
    scene.dispose()
    return patch
  }

  test('mint the scene ids: the same effect recomputed gives the same patch', async () => {
    const first = await build('effect_tools')
    expect(first.nodeCreates.map(({ node }) => node.type)).toEqual(
      expect.arrayContaining(['unit', 'roof', 'column', 'item', 'door', 'window']),
    )
    expect(await build('effect_tools')).toEqual(first)
  })
})

describe('SceneBridge commits', () => {
  test('an edit and the roof it moves land in one commit and one undo step', () => {
    const bridge = new SceneBridge()
    const level = LevelNode.parse({ id: 'level_w', parentId: 'building_w', level: 0, height: 3 })
    const upper = LevelNode.parse({ id: 'level_u', parentId: 'building_w', level: 1, height: 3 })
    const corners: [number, number][] = [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]
    const walls = corners.map((start, index) =>
      WallNode.parse({
        id: `wall_${index}`,
        parentId: level.id,
        start,
        end: corners[(index + 1) % 4]!,
        height: 3,
      }),
    )
    const roof = RoofNode.parse({
      id: 'roof_w',
      parentId: upper.id,
      support: { kind: 'walls' },
      position: [2, 0, 1.5],
    })
    level.children = walls.map((wall) => wall.id)
    upper.children = [roof.id]
    const building = BuildingNode.parse({ id: 'building_w', children: [level.id, upper.id] })
    bridge.setScene(
      Object.fromEntries(
        [building, level, upper, ...walls, roof].map((node) => [node.id, node]),
      ) as never,
      [building.id] as never,
    )
    bridge.clearHistory()
    const roofY = () => (bridge.getNode('roof_w' as AnyNodeId) as RoofNode).position[1]
    const settledY = roofY()
    const commits: SceneCommit[] = []
    const stop = subscribeSceneCommits((commit) => commits.push(commit))
    try {
      bridge.updateNode('wall_0' as AnyNodeId, { height: 4.2 } as never)
    } finally {
      stop()
    }
    expect(roofY()).toBeGreaterThan(settledY)
    expect(commits).toHaveLength(1)
    expect((commits[0]!.current.nodes['roof_w' as AnyNodeId] as RoofNode).position[1]).toBe(roofY())
    expect(commits[0]!.changedNodeIds).toContain('roof_w' as AnyNodeId)
    expect(bridge.getHistory().pastCount).toBe(1)
    bridge.undo()
    expect(roofY()).toBe(settledY)
  })
})

describe('SceneOperations without runInScene', () => {
  test('a custom implementation serves the shared tools, its ids unscoped', async () => {
    const operations = createSceneOperations({ bridge: new SceneBridge() })
    // A host's own implementation predating the scene scope.
    const custom = new Proxy(operations, {
      get: (target, key) => {
        if (key === 'runInScene') return undefined
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as SceneOperations
    const bridge = new SceneBridge()
    bridge.setScene(snapshot().nodes as never, snapshot().rootNodeIds as never)
    const client = await connect(createPascalMcpServer({ bridge, operations: custom }))
    const result = await client.callTool({
      name: 'add_wall',
      arguments: { levelId: 'level_g', start: [0, 0], end: [3, 0] },
    })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  })
})

describe('SceneBridge writes on a detached scene', () => {
  test("copy what they are given: the caller's objects stay theirs", () => {
    const scene = detached('effect_copy')
    const bridge = new SceneBridge({ runtime: scene })
    const metadata = { note: { tags: ['one'] } }
    bridge.updateNode('level_g' as AnyNodeId, { metadata } as never)
    metadata.note.tags.push('two')
    expect(bridge.getNode('level_g' as AnyNodeId)?.metadata).toEqual({ note: { tags: ['one'] } })

    const collections = {
      collection_a: { id: 'collection_a', name: 'A', nodeIds: ['level_g'] },
    } as never as Record<string, { nodeIds: string[] }>
    bridge.setCollections(collections as never)
    collections.collection_a!.nodeIds.push('building_b')
    expect(bridge.getCollections()['collection_a' as never]).toMatchObject({ nodeIds: ['level_g'] })

    const replacement = snapshot()
    const level = replacement.nodes['level_g' as AnyNodeId] as AnyNode & {
      metadata: Record<string, unknown>
    }
    level.metadata = { tags: ['one'] }
    bridge.setScene(replacement.nodes, replacement.rootNodeIds)
    ;(level.metadata.tags as string[]).push('two')
    expect(bridge.getNode('level_g' as AnyNodeId)?.metadata).toEqual({ tags: ['one'] })
    scene.dispose()
  })
  /** A rename of one chair, written by `write`; what it recorded, checked against edits meanwhile. */
  async function readsOf(write: (bridge: SceneBridge) => Promise<void> | void) {
    const base = snapshot()
    const upper = LevelNode.parse({ id: 'level_u', parentId: 'building_b', level: 1, height: 2.8 })
    const wall = (id: string) =>
      WallNode.parse({ id, parentId: upper.id, start: [0, 0], end: [4, 0], height: 2.8 })
    const chair = ItemNode.parse({
      id: 'item_a',
      parentId: 'level_g',
      position: [1, 0, 1],
      asset: {
        id: 'chair',
        name: 'Chair',
        category: 'furniture',
        thumbnail: '/items/chair/thumbnail.webp',
        src: '/items/chair/model.glb',
      },
    })
    const away = wall('wall_b')
    const building = base.nodes['building_b' as AnyNodeId] as BuildingNode
    const level = base.nodes['level_g' as AnyNodeId] as LevelNode
    const from = {
      ...base,
      nodes: {
        ...base.nodes,
        [building.id]: { ...building, children: [level.id, upper.id] },
        [level.id]: { ...level, children: [chair.id] },
        [upper.id]: { ...upper, children: [away.id] },
        [chair.id]: chair,
        [away.id]: away,
      },
    } as SceneSnapshot
    const scene = detached('effect_reads', from)
    const bridge = new SceneBridge({ runtime: scene })
    bridge.setActiveScene({ id: 'scene_reads', name: 'Reads' } as never)
    await write(bridge)
    const patch = scene.patch()
    const dependencies = scene.dependencies()
    scene.dispose()
    expect(patch.nodeUpdates).toEqual([
      expect.objectContaining({ id: chair.id, data: { name: 'North' } }),
    ])

    const edited = (nodes: Record<string, AnyNode>) => ({ ...from, nodes }) as SceneSnapshot
    const { [away.id]: _gone, ...withoutAway } = from.nodes as Record<string, AnyNode>
    const meanwhile = [
      edited({
        ...from.nodes,
        [upper.id]: { ...upper, children: [away.id, 'wall_c'] },
        wall_c: wall('wall_c'),
      } as Record<string, AnyNode>),
      edited({ ...withoutAway, [upper.id]: { ...upper, children: [] } } as Record<string, AnyNode>),
    ]
    for (const current of meanwhile)
      expect(applyPatchWithDependencies(current, patch, dependencies, from).ok).toBe(true)
    const renamed = edited({ ...from.nodes, [chair.id]: { ...chair, name: 'South' } } as Record<
      string,
      AnyNode
    >)
    expect(applyPatchWithDependencies(renamed, patch, dependencies, from).ok).toBe(false)
  }

  test('read what they touch: a create or delete elsewhere meanwhile merges, a rename of the same node conflicts', async () => {
    await readsOf((bridge) => {
      bridge.applyPatch([{ op: 'update', id: 'item_a' as AnyNodeId, data: { name: 'North' } }])
    })
  })

  test('so does an MCP tool call: recording what it made reads no more of the scene', async () => {
    await readsOf(async (bridge) => {
      const client = await connect(createPascalMcpServer({ bridge }))
      const result = await client.callTool({
        name: 'apply_patch',
        arguments: { patches: [{ op: 'update', id: 'item_a', data: { name: 'North' } }] },
      })
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
    })
  })
})

describe('SceneBridge export', () => {
  test('reads materials and the plugin list as dependencies', () => {
    const base = {
      ...snapshot(),
      materials: { mat_red: { id: 'mat_red', name: 'Red', material: { color: '#ff0000' } } },
      installedPlugins: ['pascal:test'],
    } as unknown as SceneSnapshot
    const scene = detached('effect_export', base)
    const exported = new SceneBridge({ runtime: scene }).exportJSON() as Record<string, unknown>
    expect(Object.keys(exported.materials as object)).toEqual(['mat_red'])
    expect(scene.dependencies()).toEqual(
      expect.arrayContaining([{ kind: 'material', id: 'mat_red' }, { kind: 'plugins' }]),
    )
    scene.dispose()
  })
})

describe('store-only operations', () => {
  test('serve their tools: the scene scope needs no bridge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pascal-store-only-'))
    const operations = createSceneOperations({
      store: new SqliteSceneStore({ databasePath: join(directory, 'pascal.db') }),
    })
    const client = await connect(createPascalMcpServer({ bridge: new SceneBridge(), operations }))
    const result = await client.callTool({ name: 'list_scenes', arguments: {} })
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  })
})
