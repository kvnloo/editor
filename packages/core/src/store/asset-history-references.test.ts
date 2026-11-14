import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { del, get } from 'idb-keyval'
import { saveAsset } from '../index'
import { ScanNode, SceneMaterial } from '../schema'
import {
  collectSceneStoreAssetReferences,
  collectTemporalAssetReferences,
  createSceneEnvironment,
  createSceneStore,
  SceneEnvironmentDisposedError,
  type SceneSnapshot,
} from '../runtime'

function scene(url: string | null): SceneSnapshot {
  const scan = ScanNode.parse({ id: 'scan_reference', url })
  return {
    nodes: { [scan.id]: scan },
    rootNodeIds: [scan.id],
    collections: {},
    materials: {},
    installedPlugins: [],
    hasExplicitPluginInstallState: false,
  }
}

function material(id: string, url: string) {
  return SceneMaterial.parse({
    id,
    name: id,
    material: { texture: { url } },
  })
}

describe('temporal asset references', () => {
  test('unions nested node and texture references across current, past and future without mutation', () => {
    const current = scene('asset://scan-current')
    const finish = SceneMaterial.parse({
      id: 'mat_finish',
      name: 'Finish',
      material: {
        texture: { url: 'asset://albedo', normalMap: 'asset://normal' },
      },
    })
    current.materials[finish.id] = finish
    const remote = ScanNode.parse({ id: 'scan_remote', url: 'https://example.com/scan.glb' })
    const blob = ScanNode.parse({ id: 'scan_blob', url: 'blob:https://example.com/view' })
    current.nodes[remote.id] = remote
    current.nodes[blob.id] = blob
    const source = {
      current,
      pastStates: [scene('asset://from-past')],
      futureStates: [scene('asset://from-future')],
    }
    const before = structuredClone(source)

    const references = collectTemporalAssetReferences(source)

    expect(references && [...references].sort()).toEqual([
      'asset://albedo',
      'asset://from-future',
      'asset://from-past',
      'asset://normal',
      'asset://scan-current',
    ])
    expect(source).toEqual(before)
  })

  test('returns unknown for cyclic, unsupported or over-depth data instead of an empty set', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const unknownShape = {
      ...scene(null),
      nodes: { scan_unknown: { url: 'asset://present', custom: cyclic } },
    } as unknown as SceneSnapshot
    expect(
      collectTemporalAssetReferences({
        current: unknownShape,
        pastStates: [],
        futureStates: [],
      }),
    ).toBeNull()

    const unsupported = {
      ...scene(null),
      materials: { mat_unsupported: new Map([['url', 'asset://hidden']]) },
    } as unknown as SceneSnapshot
    expect(
      collectTemporalAssetReferences({ current: unsupported, pastStates: [], futureStates: [] }),
    ).toBeNull()

    let nested: Record<string, unknown> = { url: 'asset://deep' }
    for (let index = 0; index < 66; index += 1) nested = { child: nested }
    const tooDeep = {
      ...scene(null),
      nodes: { scan_deep: nested },
    } as unknown as SceneSnapshot
    expect(
      collectTemporalAssetReferences({ current: tooDeep, pastStates: [], futureStates: [] }),
    ).toBeNull()
  })

  test('keeps IndexedDB bytes readable through undo and redo until history is cleared', async () => {
    const environment = createSceneEnvironment('asset-history-bytes')
    const store = createSceneStore(environment)
    const url = await saveAsset(new File(['retained asset bytes'], 'reference.glb'))
    const key = 'asset_data:' + url.slice('asset://'.length)
    const finish = material('mat_retained', url)
    const readBytes = async () => (await get<Blob>(key))?.text()

    try {
      store.getState().addSceneMaterial(finish)
      store.getState().removeSceneMaterial(finish.id)
      expect(store.getState().materials[finish.id]).toBeUndefined()
      expect(collectSceneStoreAssetReferences(store)?.has(url)).toBe(true)
      expect(await readBytes()).toBe('retained asset bytes')

      store.temporal.getState().undo()
      expect(store.getState().materials[finish.id]).toEqual(finish)
      expect(await readBytes()).toBe('retained asset bytes')

      store.temporal.getState().redo()
      expect(store.getState().materials[finish.id]).toBeUndefined()
      expect(collectSceneStoreAssetReferences(store)?.has(url)).toBe(true)

      store.temporal.getState().clear()
      expect(collectSceneStoreAssetReferences(store)?.has(url)).toBe(false)
      expect(await readBytes()).toBe('retained asset bytes')
    } finally {
      await del(key)
      environment.dispose()
    }
  })

  test('releases a history-only reference precisely when the 50-step history evicts it', () => {
    const environment = createSceneEnvironment('asset-history-eviction')
    try {
      const store = createSceneStore(environment)
      const retained = material('mat_evicted', 'asset://evicted')
      store.getState().addSceneMaterial(retained)
      store.getState().removeSceneMaterial(retained.id)

      for (let index = 0; index < 49; index += 1) {
        store
          .getState()
          .addSceneMaterial(
            SceneMaterial.parse({ id: 'mat_fill_' + index, name: 'Fill ' + index, material: {} }),
          )
      }
      expect(store.temporal.getState().pastStates).toHaveLength(50)
      expect(collectSceneStoreAssetReferences(store)?.has('asset://evicted')).toBe(true)

      store
        .getState()
        .addSceneMaterial(
          SceneMaterial.parse({ id: 'mat_fill_49', name: 'Fill 49', material: {} }),
        )
      expect(store.temporal.getState().pastStates).toHaveLength(50)
      expect(collectSceneStoreAssetReferences(store)?.has('asset://evicted')).toBe(false)
    } finally {
      environment.dispose()
    }
  })

  test('does not union unrelated detached stores or read a disposed environment', () => {
    const firstEnvironment = createSceneEnvironment('asset-first')
    const secondEnvironment = createSceneEnvironment('asset-second')
    try {
      const first = createSceneStore(firstEnvironment)
      const second = createSceneStore(secondEnvironment)
      const firstMaterial = material('mat_first', 'asset://first')
      second.getState().addSceneMaterial(material('mat_second', 'asset://second'))
      first.getState().addSceneMaterial(firstMaterial)
      first.getState().removeSceneMaterial(firstMaterial.id)

      const secondBefore = structuredClone(second.getState().materials)
      expect([...collectSceneStoreAssetReferences(first)!]).toEqual(['asset://first'])
      expect([...collectSceneStoreAssetReferences(second)!]).toEqual(['asset://second'])
      expect(second.getState().materials).toEqual(secondBefore)

      firstEnvironment.dispose()
      expect(() => collectSceneStoreAssetReferences(first)).toThrow(SceneEnvironmentDisposedError)
      expect([...collectSceneStoreAssetReferences(second)!]).toEqual(['asset://second'])
    } finally {
      if (!firstEnvironment.disposed) firstEnvironment.dispose()
      secondEnvironment.dispose()
    }
  })
})
