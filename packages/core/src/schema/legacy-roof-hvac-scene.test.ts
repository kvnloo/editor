import { expect, test } from 'bun:test'
import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import legacyScene from './__fixtures__/legacy-roof-hvac-scene.json'

globalThis.requestAnimationFrame ??= (callback) => {
  callback(0)
  return 0
}
globalThis.cancelAnimationFrame ??= () => {}

test('a saved roof, box vent, HVAC unit and suction line survive load and resave', () => {
  const previous = useScene.getState()
  try {
    const nodes = JSON.parse(JSON.stringify(legacyScene.nodes)) as Record<AnyNodeId, AnyNode>
    const rootNodeIds = [...legacyScene.rootNodeIds] as AnyNodeId[]

    useScene.getState().setScene(nodes, rootNodeIds)
    const firstLoad = useScene.getState()
    expect(firstLoad.rootNodeIds).toEqual(rootNodeIds)
    expect(Object.keys(firstLoad.nodes).sort()).toEqual(Object.keys(nodes).sort())

    for (const [id, saved] of Object.entries(nodes)) {
      const loaded = firstLoad.nodes[id as AnyNodeId]
      expect(loaded).toMatchObject({
        id: saved.id,
        type: saved.type,
        parentId: saved.parentId,
      })
      if ('children' in saved) expect(loaded).toMatchObject({ children: saved.children })
    }

    expect(Object.values(firstLoad.nodes).find((node) => node.type === 'box-vent')).toMatchObject({
      roofSegmentId: 'rseg_m0ysxl4fi5ou8qxt',
      style: 'cap',
      position: [0, 0, 0],
      width: 0.4,
      depth: 0.4,
      height: 0.15,
    })
    expect(
      Object.values(firstLoad.nodes).find((node) => node.type === 'hvac-equipment'),
    ).toMatchObject({
      equipmentType: 'furnace',
      position: [1, 0, 0],
      supplyDiameter: 8,
      returnDiameter: 8,
    })
    expect(Object.values(firstLoad.nodes).find((node) => node.type === 'lineset')).toMatchObject({
      path: [
        [1.28, 0.88, 0],
        [3, 0.88, 0],
      ],
      suctionDiameter: 0.875,
      liquidDiameter: 0.75,
    })

    const savedAgain = JSON.parse(JSON.stringify(firstLoad.nodes)) as Record<AnyNodeId, AnyNode>
    useScene.getState().setScene(savedAgain, rootNodeIds)
    expect(JSON.parse(JSON.stringify(useScene.getState().nodes))).toEqual(savedAgain)
  } finally {
    useScene.setState(previous)
    useScene.temporal.getState().clear()
  }
})
