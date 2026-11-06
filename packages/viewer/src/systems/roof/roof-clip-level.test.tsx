// @ts-expect-error — bun:test is provided by Bun; viewer has no @types/bun.
import { expect, test } from 'bun:test'
import {
  type AnyNode,
  type AnyNodeId,
  BuildingNode,
  getLevelElevations,
  LevelNode,
  RoofNode,
  RoofSegmentNode,
  sceneRegistry,
  useRegistry,
  useScene,
} from '@pascal-app/core'
import { RoofSystem } from '@pascal-app/viewer'
import { create } from '@react-three/test-renderer'
import { useRef } from 'react'
import * as THREE from 'three'

function twoLevelScene() {
  const building = BuildingNode.parse({
    id: 'building',
    type: 'building',
    children: ['level_ground', 'level_upper'],
  })
  const ground = LevelNode.parse({
    id: 'level_ground',
    type: 'level',
    parentId: building.id,
    level: 0,
    height: 3,
    children: ['roof_ground'],
  })
  const upper = LevelNode.parse({
    id: 'level_upper',
    type: 'level',
    parentId: building.id,
    level: 1,
    height: 3,
    children: [],
  })
  const roof = RoofNode.parse({
    id: 'roof_ground',
    type: 'roof',
    parentId: ground.id,
    position: [0, 0, 0],
    children: ['segment_ground'],
  })
  const segment = RoofSegmentNode.parse({
    id: 'segment_ground',
    type: 'roof-segment',
    parentId: roof.id,
    roofType: 'shed',
    width: 4,
    depth: 4,
    pitch: 0,
    wallHeight: 1.2,
    wallThickness: 0.1,
    deckThickness: 0.2,
    overhang: 0,
    wallShell: 'omit',
  })
  const nodes: Record<string, AnyNode> = {
    [building.id]: building,
    [ground.id]: ground,
    [upper.id]: upper,
    [roof.id]: roof,
    [segment.id]: segment,
  }
  const roots: AnyNodeId[] = [building.id]
  return { nodes, roots }
}

function post(height: number) {
  const source = new THREE.BoxGeometry(0.2, height, 0.2)
  source.translate(0, height / 2, 0)
  const mesh = new THREE.Mesh(source, new THREE.MeshBasicMaterial())
  const group = new THREE.Group()
  group.add(mesh)
  return { source, mesh, group }
}

function MountedLevel({ id, group }: { id: string; group: THREE.Group }) {
  const ref = useRef<THREE.Group>(null)
  useRegistry(id, 'level', ref)
  return <primitive object={group} ref={ref} />
}

test('a ground-floor roof clips its own post without cutting the upper storey', async () => {
  const savedScene = useScene.getState()
  sceneRegistry.clear()
  const ground = post(3)
  const upper = post(1)
  const data = twoLevelScene()
  expect(getLevelElevations(data.nodes as Record<AnyNodeId, AnyNode>).get('level_upper')?.baseY).toBe(
    3,
  )
  useScene.getState().setScene(data.nodes, data.roots)
  const renderer = await create(
    <>
      <MountedLevel id="level_ground" group={ground.group} />
      <MountedLevel id="level_upper" group={upper.group} />
      <RoofSystem />
    </>,
  )
  try {
    await renderer.advanceFrames(1, 1 / 60)
    const clippedGround = ground.mesh.geometry
    expect(clippedGround).not.toBe(ground.source)
    clippedGround.computeBoundingBox()
    expect(clippedGround.boundingBox!.max.y).toBeCloseTo(1.2, 4)
    // The upper post occupies building-space y=3..4, wholly above the lower roof.
    expect(upper.mesh.geometry).toBe(upper.source)
  } finally {
    await renderer.unmount()
    useScene.setState(savedScene, true)
    sceneRegistry.clear()
    for (const { source, mesh } of [ground, upper]) {
      if (mesh.geometry !== source) mesh.geometry.dispose()
      source.dispose()
      mesh.material.dispose()
    }
  }
})
