import { expect, test } from 'bun:test'
import {
  type AnyNodeId,
  BuildingNode,
  createSceneApi,
  emitter,
  LevelNode,
  nodeRegistry,
  RoofNode,
  RoofSegmentNode,
  registerNode,
  sceneRegistry,
  useScene,
} from '@pascal-app/core'
import {
  EDITOR_LAYER,
  RegistryToolProvider,
  useEditor,
  usePlacementPreview,
} from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { act, create } from '@react-three/test-renderer'
import * as THREE from 'three'
import { chimneyDefinition } from '../chimney'
import { boxVentDefinition, buildBoxVentGeometry } from './index'

test('box-vent placement matches its preview, honors grid mode and blocks unsupported drops', async () => {
  const restoreRegistry = nodeRegistry._snapshot()
  if (!nodeRegistry.get('box-vent')) registerNode(boxVentDefinition)
  const savedEditor = useEditor.getState()
  useEditor.setState({ mode: 'build', tool: 'box-vent', gridSnapStep: 0.25 })
  useEditor.getState().setSnappingMode('item', 'grid')
  const savedScene = useScene.getState()
  const savedSelection = useViewer.getState().selection
  const building = BuildingNode.parse({})
  const level = LevelNode.parse({ parentId: building.id })
  const roof = RoofNode.parse({ parentId: level.id })
  const segment = RoofSegmentNode.parse({ parentId: roof.id, width: 20, depth: 20 })
  roof.children = [segment.id]
  level.children = [roof.id]
  building.children = [level.id]
  useScene.setState({
    nodes: { [building.id]: building, [level.id]: level, [roof.id]: roof, [segment.id]: segment },
    rootNodeIds: [building.id],
    dirtyNodes: new Set(),
    readOnly: false,
  })
  useViewer.getState().setSelection({ buildingId: building.id, levelId: level.id })
  sceneRegistry.nodes.set(segment.id, new THREE.Group())
  const dirtyNotifications: AnyNodeId[] = []
  const baseApi = createSceneApi(useScene)
  const { default: Tool } = await boxVentDefinition.tool!()
  const renderer = await create(
    <RegistryToolProvider
      value={{
        activeLevelId: level.id,
        isCameraDragging: () => false,
        sceneApi: {
          ...baseApi,
          markDirty: (id: AnyNodeId) => {
            dirtyNotifications.push(id)
            baseApi.markDirty(id)
          },
        },
        selectNode: () => {},
        unit: 'metric',
      }}
    >
      <Tool />
    </RegistryToolProvider>,
  )
  try {
    const event = {
      node: roof,
      position: [0.13, 3, 3.13] as [number, number, number],
      stopPropagation: () => {},
    }
    await act(async () => emitter.emit('roof:move', event))
    let renderables = 0
    renderer.scene.instance.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return
      renderables++
      expect(object.layers.isEnabled(0)).toBe(false)
      expect(object.layers.isEnabled(EDITOR_LAYER)).toBe(true)
    })
    expect(renderables).toBeGreaterThan(0)
    const preview = usePlacementPreview.getState().node
    expect(preview?.type).toBe('box-vent')
    if (preview?.type !== 'box-vent') throw new Error('Missing box-vent preview')
    await act(async () => emitter.emit('roof:click', event))
    const placed = Object.values(useScene.getState().nodes).find((node) => node.type === 'box-vent')
    expect(useScene.getState().dirtyNodes.has(segment.id)).toBe(true)
    expect(dirtyNotifications).toContain(segment.id)
    expect(placed).toBeDefined()
    if (placed?.type !== 'box-vent') throw new Error('Missing box vent')
    expect(preview.position).toEqual(placed.position)
    expect(placed.position[0]).toBe(0.25)
    expect(placed.position[2]).toBe(3.25)
    expect(placed.flashingWidth).toBe(0.05)
    expect(preview.id).not.toBe(placed.id)
    const previewGeometry = buildBoxVentGeometry(preview)!
    const placedGeometry = buildBoxVentGeometry(placed)!
    previewGeometry.computeBoundingBox()
    placedGeometry.computeBoundingBox()
    expect(previewGeometry.boundingBox!.equals(placedGeometry.boundingBox!)).toBe(true)
    previewGeometry.dispose()
    placedGeometry.dispose()
    expect(usePlacementPreview.getState().node).toBeNull()
    const outside = { ...event, position: [30, 3, 3] as [number, number, number] }
    await act(async () => emitter.emit('roof:click', outside))
    expect(
      Object.values(useScene.getState().nodes).filter((n) => n.type === 'box-vent'),
    ).toHaveLength(1)
    await act(async () =>
      emitter.emit('roof:click', { ...outside, nativeEvent: { altKey: true } as never }),
    )
    expect(
      Object.values(useScene.getState().nodes).filter((n) => n.type === 'box-vent'),
    ).toHaveLength(2)
  } finally {
    restoreRegistry()
    useEditor.setState(savedEditor)
    await renderer.unmount()
    sceneRegistry.nodes.delete(segment.id)
    useScene.setState(savedScene)
    useViewer.getState().setSelection(savedSelection)
    usePlacementPreview.getState().clear()
  }
})

test('roof accessories snap to the actual neighbouring segment and dirty that host', async () => {
  const restoreRegistry = nodeRegistry._snapshot()
  if (!nodeRegistry.get('box-vent')) registerNode(boxVentDefinition)
  if (!nodeRegistry.get('chimney')) registerNode(chimneyDefinition)
  const savedEditor = useEditor.getState()
  const savedScene = useScene.getState()
  const savedSelection = useViewer.getState().selection
  const building = BuildingNode.parse({})
  const level = LevelNode.parse({ parentId: building.id })
  const roof = RoofNode.parse({ parentId: level.id })
  const source = RoofSegmentNode.parse({
    parentId: roof.id,
    roofType: 'flat',
    width: 8,
    depth: 8,
    overhang: 0,
    gableOverhang: 0,
    wallThickness: 0,
  })
  const neighbour = RoofSegmentNode.parse({ ...source, id: undefined, parentId: roof.id })
  roof.children = [source.id, neighbour.id]
  level.children = [roof.id]
  building.children = [level.id]
  const neighbourObject = new THREE.Group()
  neighbourObject.position.x = 7
  sceneRegistry.nodes.set(building.id, new THREE.Group())
  sceneRegistry.nodes.set(source.id, new THREE.Group())
  sceneRegistry.nodes.set(neighbour.id, neighbourObject)
  let renderer: Awaited<ReturnType<typeof create>> | null = null

  try {
    for (const definition of [boxVentDefinition, chimneyDefinition]) {
      useScene.setState({
        nodes: {
          [building.id]: building,
          [level.id]: level,
          [roof.id]: roof,
          [source.id]: source,
          [neighbour.id]: neighbour,
        },
        rootNodeIds: [building.id],
        dirtyNodes: new Set(),
        readOnly: false,
      })
      useViewer.getState().setSelection({ buildingId: building.id, levelId: level.id })
      useEditor.setState({ mode: 'build', tool: definition.kind, gridSnapStep: 1.1 })
      useEditor.getState().setSnappingMode('item', 'grid')
      const marks: AnyNodeId[] = []
      const baseApi = createSceneApi(useScene)
      const { default: Tool } = await definition.tool!()
      renderer = await create(
        <RegistryToolProvider
          value={{
            activeLevelId: level.id,
            isCameraDragging: () => false,
            sceneApi: {
              ...baseApi,
              markDirty: (id: AnyNodeId) => {
                marks.push(id)
                baseApi.markDirty(id)
              },
            },
            selectNode: () => {},
            unit: 'metric',
          }}
        >
          <Tool />
        </RegistryToolProvider>,
      )
      const event = {
        node: roof,
        position: [3.95, 3, 1.1] as [number, number, number],
        stopPropagation: () => {},
      }
      await act(async () => emitter.emit('roof:move', event))
      const preview = usePlacementPreview.getState().node
      if (preview?.type !== 'box-vent' && preview?.type !== 'chimney') {
        throw new Error('Missing roof accessory preview')
      }
      expect(preview.roofSegmentId).toBe(neighbour.id)
      expect(preview.parentId).toBe(neighbour.id)

      await act(async () => emitter.emit('roof:click', event))
      const placed = Object.values(useScene.getState().nodes).find(
        (n) => n.type === definition.kind,
      )
      if (placed?.type !== 'box-vent' && placed?.type !== 'chimney') {
        throw new Error('Missing roof accessory')
      }
      expect(placed.parentId).toBe(neighbour.id)
      expect(placed.roofSegmentId).toBe(neighbour.id)
      expect(placed.position[0]).toBeCloseTo(-2.6)
      expect(placed.position[2]).toBeCloseTo(1.1)
      expect(marks).toContain(neighbour.id)
      await renderer.unmount()
      renderer = null
      usePlacementPreview.getState().clear()
    }
  } finally {
    if (renderer) await renderer.unmount()
    restoreRegistry()
    useEditor.setState(savedEditor)
    useScene.setState(savedScene)
    useViewer.getState().setSelection(savedSelection)
    sceneRegistry.nodes.delete(building.id)
    sceneRegistry.nodes.delete(source.id)
    sceneRegistry.nodes.delete(neighbour.id)
    usePlacementPreview.getState().clear()
  }
})
