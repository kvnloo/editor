import type { SceneSnapshot } from './history-control'
import type { SceneStore } from './use-scene'

type AssetScene = Pick<SceneSnapshot, 'nodes' | 'materials' | 'collections'>

export type TemporalAssetReferenceSource = {
  current: AssetScene
  pastStates: readonly Partial<AssetScene>[]
  futureStates: readonly Partial<AssetScene>[]
}

const MAX_ASSET_REFERENCE_DEPTH = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Conservatively unions local asset URLs in the current graph and both history stacks.
 * Null means some graph was not completely inspectable; absence cannot be certified.
 * This is not permission to delete bytes without a fenced, cross-scene host inventory.
 */
export function collectTemporalAssetReferences(
  source: TemporalAssetReferenceSource,
): ReadonlySet<string> | null {
  if (!Array.isArray(source.pastStates) || !Array.isArray(source.futureStates)) return null

  const references = new Set<string>()
  const visited = new WeakSet<object>()
  const active = new WeakSet<object>()

  function visit(value: unknown, depth: number): boolean {
    if (depth > MAX_ASSET_REFERENCE_DEPTH) return false
    if (typeof value === 'string') {
      if (value.startsWith('asset://')) {
        if (value.length === 'asset://'.length) return false
        references.add(value)
      }
      return true
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return true
    if (typeof value !== 'object') return false
    if (active.has(value)) return false
    if (visited.has(value)) return true
    if (!(Array.isArray(value) || isRecord(value))) return false

    active.add(value)
    for (const child of Object.values(value)) {
      if (!visit(child, depth + 1)) return false
    }
    active.delete(value)
    visited.add(value)
    return true
  }

  for (const state of [source.current, ...source.pastStates, ...source.futureStates]) {
    if (
      !isRecord(state) ||
      !isRecord(state.nodes) ||
      !isRecord(state.materials) ||
      !isRecord(state.collections)
    ) {
      return null
    }
    if (!visit(state.nodes, 0) || !visit(state.materials, 0) || !visit(state.collections, 0)) {
      return null
    }
  }
  return references
}

/** Reads only this store's temporal stacks, including a detached scene's own environment. */
export function collectSceneStoreAssetReferences(store: SceneStore): ReadonlySet<string> | null {
  const current = store.getState()
  const { pastStates, futureStates } = store.temporal.getState()
  return collectTemporalAssetReferences({ current, pastStates, futureStates })
}
