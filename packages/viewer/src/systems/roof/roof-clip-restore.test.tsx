// @ts-expect-error — bun:test is provided by Bun; viewer has no @types/bun.
import { expect, spyOn, test } from 'bun:test'
import {
  type AnyNode,
  type AnyNodeId,
  BuildingNode,
  LevelNode,
  RoofNode,
  RoofSegmentNode,
  sceneRegistry,
  useRegistry,
  useScene,
} from '@pascal-app/core'
import { RoofSystem } from '@pascal-app/viewer'
import { act, create } from '@react-three/test-renderer'
import { useRef } from 'react'
import * as THREE from 'three'

function scene(activeRoofs: ReadonlySet<string>) {
  const nodes: Record<string, AnyNode> = {}
  const roots: AnyNodeId[] = []
  for (const suffix of ['a', 'b']) {
    const levelId = `level_${suffix}`
    const roofId = `roof_${suffix}`
    const segmentId = `segment_${suffix}`
    const building = BuildingNode.parse({
      id: `building_${suffix}`,
      type: 'building',
      children: [levelId],
    })
    const level = LevelNode.parse({
      id: levelId,
      type: 'level',
      parentId: building.id,
      level: 0,
      height: 3,
      children: activeRoofs.has(suffix) ? [roofId] : [],
    })
    nodes[building.id] = building
    nodes[level.id] = level
    roots.push(building.id)
    if (!activeRoofs.has(suffix)) continue
    const roof = RoofNode.parse({
      id: roofId,
      type: 'roof',
      parentId: level.id,
      position: [0, 0, 0],
      children: [segmentId],
    })
    const segment = RoofSegmentNode.parse({
      id: segmentId,
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
    nodes[roof.id] = roof
    nodes[segment.id] = segment
  }
  return { nodes, roots }
}

function post() {
  const source = new THREE.BoxGeometry(0.2, 3, 0.2)
  source.translate(0, 1.5, 0)
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

test('mounted roof system restores each clipped mesh when its roof disappears', async () => {
  const savedScene = useScene.getState()
  sceneRegistry.clear()
  const a = post()
  const b = post()
  const initial = scene(new Set(['a', 'b']))
  useScene.getState().setScene(initial.nodes, initial.roots)
  const renderer = await create(
    <>
      <MountedLevel id="level_a" group={a.group} />
      <MountedLevel id="level_b" group={b.group} />
      <RoofSystem />
    </>,
  )
  try {
    await renderer.advanceFrames(1, 1 / 60)
    const clippedA = a.mesh.geometry
    const clippedB = b.mesh.geometry
    expect(clippedA).not.toBe(a.source)
    expect(clippedB).not.toBe(b.source)
    clippedA.computeBoundingBox()
    expect(clippedA.boundingBox!.max.y).toBeLessThan(3)
    const disposeA = spyOn(clippedA, 'dispose')
    const disposeB = spyOn(clippedB, 'dispose')

    // Another building still has a roof; only B's geometry must return.
    await act(async () => {
      const remaining = scene(new Set(['a']))
      useScene.getState().setScene(remaining.nodes, remaining.roots)
    })
    await renderer.advanceFrames(1, 1 / 60)
    expect(a.mesh.geometry).toBe(clippedA)
    expect(b.mesh.geometry).toBe(b.source)
    expect(disposeB).toHaveBeenCalledTimes(1)

    // Removing the final roof must also restore A, not early-return.
    await act(async () => {
      const empty = scene(new Set())
      useScene.getState().setScene(empty.nodes, empty.roots)
    })
    await renderer.advanceFrames(1, 1 / 60)
    expect(a.mesh.geometry).toBe(a.source)
    expect(disposeA).toHaveBeenCalledTimes(1)
  } finally {
    await renderer.unmount()
    useScene.setState(savedScene, true)
    sceneRegistry.clear()
    for (const { source, mesh } of [a, b]) {
      if (mesh.geometry !== source) mesh.geometry.dispose()
      source.dispose()
      mesh.material.dispose()
    }
  }
})
