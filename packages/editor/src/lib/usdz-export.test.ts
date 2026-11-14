import { expect, test } from 'bun:test'
import { exportSceneToUsdz } from '@pascal-app/editor'
import { strFromU8, unzipSync } from 'fflate'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'

test('USDZ export declares metre scale and Y-up in its root layer', async () => {
  const scene = new Group()
  scene.name = 'scene-renderer'
  scene.add(new Mesh(new BoxGeometry(1, 2, 3), new MeshStandardMaterial()))

  const archive = unzipSync(await exportSceneToUsdz(scene, {}))
  const model = archive['model.usda']
  expect(model).toBeDefined()
  expect(Object.keys(archive).some((path) => path.startsWith('geometries/'))).toBe(true)

  const header = strFromU8(model!).match(/^#usda 1\.0\r?\n\(([\s\S]*?)\r?\n\)/)
  expect(header).not.toBeNull()

  const stageMetadata = header![1]!
  const metresPerUnit = Array.from(
    stageMetadata.matchAll(/^[ \t]*metersPerUnit[ \t]*=[ \t]*([^\r\n]+)/gm),
    (match) => Number(match[1]!.trim()),
  )
  const upAxes = Array.from(
    stageMetadata.matchAll(/^[ \t]*upAxis[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*$/gm),
    (match) => match[1],
  )

  expect(metresPerUnit).toEqual([1])
  expect(upAxes).toEqual(['Y'])
})
