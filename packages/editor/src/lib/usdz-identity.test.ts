import { afterEach, expect, test } from 'bun:test'
import { type AnyNode, BlockNode, LevelNode, sceneRegistry } from '@pascal-app/core'
import { decodeUsdzPascalIdentity, exportSceneToUsdz } from '@pascal-app/editor'
import { strFromU8, unzipSync } from 'fflate'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'

afterEach(() => {
  sceneRegistry.clear()
})

function identitiesInUsda(usda: string) {
  return [...usda.matchAll(/^\s*def Xform "([^"]+)"/gm)]
    .flatMap(([, name]) => {
      const identity = decodeUsdzPascalIdentity(name!)
      return identity ? [identity] : []
    })
    .sort((a, b) => a.pascalId.localeCompare(b.pascalId))
}

test('USDZ root layer retains registered level and model identities independently', async () => {
  const block = BlockNode.parse({ id: 'block_wall:blue', parentId: 'level_ground-1' })
  const level = LevelNode.parse({ id: 'level_ground-1', children: [block.id] })
  const nodes: Record<string, AnyNode> = { [level.id]: level, [block.id]: block }

  const root = new Group()
  root.name = 'scene-renderer'
  const levelObject = new Group()
  levelObject.name = 'Ground level'
  const blockObject = new Group()
  blockObject.name = 'Blue wall'
  blockObject.add(new Mesh(new BoxGeometry(1, 2, 3), new MeshStandardMaterial()))
  levelObject.add(blockObject)
  root.add(levelObject)
  sceneRegistry.nodes.set(level.id, levelObject)
  sceneRegistry.nodes.set(block.id, blockObject)

  const archive = unzipSync(await exportSceneToUsdz(root, nodes))
  const model = archive['model.usda']
  expect(model).toBeDefined()
  expect(Object.keys(archive).some((name) => name.startsWith('geometries/'))).toBe(true)
  const usda = strFromU8(model!)
  const levelIdentity = { pascalId: level.id, kind: 'level' }
  const blockIdentity = { pascalId: block.id, kind: 'block' }
  const expected = [blockIdentity, levelIdentity]

  expect(identitiesInUsda(usda)).toEqual(expected)

  const blockPrim = [...usda.matchAll(/^\s*def Xform "([^"]+)"/gm)]
    .map((match) => match[1]!)
    .find((name) => decodeUsdzPascalIdentity(name)?.pascalId === block.id)
  expect(blockPrim).toBeDefined()
  const declaration = `def Xform "${blockPrim}"`
  expect(usda).toContain(declaration)
  expect(identitiesInUsda(usda.replace(declaration, 'def Xform "renamed"'))).toEqual([
    levelIdentity,
  ])
  expect(identitiesInUsda(usda.replace(declaration, ''))).toEqual([levelIdentity])
  expect(decodeUsdzPascalIdentity('PascalId_6c_Kind_6')).toBeNull()
  expect(decodeUsdzPascalIdentity('PascalId_ff_Kind_6c')).toBeNull()

  // The names on the live renderer must not be replaced by USD identifiers.
  expect(levelObject.name).toBe('Ground level')
  expect(blockObject.name).toBe('Blue wall')
})
