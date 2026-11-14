import type { AnyNode } from '@pascal-app/core'
import type { Object3D } from 'three'
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js'
import { createExportTextureUtils } from './export-texture-utils'
import {
  DEFAULT_MODEL_EXPORT_TIMEOUT_MS,
  type GlbExport,
  type GlbExportOptions,
  preparePortableSceneFromViewer,
  withExportDeadline,
} from './glb-export'
import { createUsdzScene, disposeExportResources } from './portable-export'

export type UsdzExportOptions = Pick<
  GlbExportOptions,
  'excludedNodeTypes' | 'includedPresentationIds' | 'onlyVisible' | 'onWarning' | 'timeoutMs'
>

const USDZ_PASCAL_PRIM_NAME = /^PascalId_([0-9a-f]+)_Kind_([0-9a-f]+)$/

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function decodeUtf8Hex(value: string): string {
  const bytes = new Uint8Array(value.length / 2)
  for (let offset = 0; offset < value.length; offset += 2) {
    bytes[offset / 2] = Number.parseInt(value.slice(offset, offset + 2), 16)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Recover the exact node ID and kind from a Pascal-named USDZ prim. */
export function decodeUsdzPascalIdentity(
  primName: string,
): { pascalId: string; kind: string } | null {
  const match = USDZ_PASCAL_PRIM_NAME.exec(primName)
  if (!match || match[1]!.length % 2 !== 0 || match[2]!.length % 2 !== 0) return null
  try {
    return {
      pascalId: decodeUtf8Hex(match[1]!),
      kind: decodeUtf8Hex(match[2]!),
    }
  } catch {
    return null
  }
}

/**
 * USDZExporter r186 serializes Object3D.name into prim names, removing
 * punctuation; it does not serialize userData into prim customData.
 * Encode the identities already stamped by shared GLB/USDZ preparation.
 */
function nameUsdzIdentityPrims(scene: Object3D): void {
  scene.traverse((object) => {
    const { pascalId, kind } = object.userData
    if (typeof pascalId !== 'string' || typeof kind !== 'string') return
    object.name = `PascalId_${utf8Hex(pascalId)}_Kind_${utf8Hex(kind)}`
  })
}

/** Export a native, self-contained USDZ with no glTF conversion fallback. */
export async function exportSceneToUsdz(
  sceneGroup: Object3D,
  nodes: Record<string, AnyNode>,
  options: UsdzExportOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const textureUtils = createExportTextureUtils()
  const preparation = preparePortableSceneFromViewer(sceneGroup, nodes, {
    ...options,
    textures: 'embed',
    animations: 'none',
    textureUtils,
  })
  // Assigned inside the raced closure, so plain `let`s narrow to `never` in
  // the `finally`.
  const run: { prepared: GlbExport | null; scene: Object3D | null; abandoned: boolean } = {
    prepared: null,
    scene: null,
    abandoned: false,
  }
  try {
    return await withExportDeadline(
      (async () => {
        run.prepared = await preparation
        if (run.abandoned) throw new Error('USDZ export abandoned')
        for (const warning of run.prepared.warnings) options.onWarning?.(warning)
        run.scene = createUsdzScene(run.prepared.scene)
        nameUsdzIdentityPrims(run.scene)
        const exporter = new USDZExporter()
        exporter.textureUtils = textureUtils as unknown as USDZExporter['textureUtils']
        return exporter.parseAsync(run.scene, {
          onlyVisible: options.onlyVisible ?? true,
          quickLookCompatible: true,
        })
      })(),
      options.timeoutMs ?? DEFAULT_MODEL_EXPORT_TIMEOUT_MS,
      'USDZ',
      () => {
        run.abandoned = true
      },
    )
  } finally {
    if (run.scene) disposeExportResources(run.scene, { textures: false })
    if (run.prepared) run.prepared.dispose()
    else preparation.then((late) => late.dispose()).catch(() => {})
    await textureUtils.dispose()
  }
}
