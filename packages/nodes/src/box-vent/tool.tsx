'use client'

import { type AnyNodeId, BoxVentNode, emitter, type RoofEvent } from '@pascal-app/core'
import {
  isGridSnapActive,
  isMagneticSnapActive,
  triggerSFX,
  useEditor,
  usePlacementPreview,
  useRegistryToolContext,
} from '@pascal-app/editor'
import { getRoofOuterSurfaceFrameAtPoint, useViewer } from '@pascal-app/viewer'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { roofSegmentLocalToBuildingLocal } from '../shared/relative-roof-drag'
import { RoofAttachmentFallbackPreview } from '../shared/roof-attachment-fallback-preview'
import {
  resolveRoofSegmentAtSnappedPosition,
  resolveRoofSegmentHit,
} from '../shared/roof-segment-hit'
import { surfaceQuatFromNormal } from '../shared/roof-surface'
import {
  clearRoofSurfacePlacementGuides,
  publishRoofSurfaceNodePlacementGuides,
  snapRoofSurfaceNodeTarget,
} from '../shared/roof-surface-placement-guides'
import { boxVentDefinition } from './definition'
import { resolveBoxVentPlacement } from './placement'
import BoxVentPreview from './preview'

export default function BoxVentTool() {
  const { sceneApi } = useRegistryToolContext()
  const activeBuildingId = useViewer((s) => s.selection.buildingId)
  const seed = useMemo(
    () => BoxVentNode.parse({ ...boxVentDefinition.defaults(), name: 'Box Vent' }),
    [],
  )
  const [preview, setPreview] = useState<{
    node: BoxVentNode
    position: [number, number, number]
    normal: THREE.Quaternion
    yaw: number
    valid: boolean
  } | null>(null)

  useEffect(() => {
    if (!activeBuildingId) return
    const clear = () => {
      setPreview(null)
      if (usePlacementPreview.getState().node?.id === seed.id)
        usePlacementPreview.getState().clear()
      clearRoofSurfacePlacementGuides()
    }
    const resolve = (event: RoofEvent) => {
      const hit = resolveRoofSegmentHit(event.node, ...event.position)
      if (!hit) return null
      const force = event.nativeEvent?.altKey === true
      const gridStep = !force && isGridSnapActive() ? useEditor.getState().gridSnapStep : 0
      let placement = resolveBoxVentPlacement(hit.segment, seed, hit.localX, hit.localZ, {
        gridStep,
        alignDownslope: true,
      })
      let target = {
        ...hit,
        hit,
        localX: placement.position[0],
        localY: placement.position[1],
        localZ: placement.position[2],
      }
      if (gridStep > 0) {
        target = resolveRoofSegmentAtSnappedPosition(event.node, target)
        placement = resolveBoxVentPlacement(target.segment, seed, target.localX, target.localZ, {
          alignDownslope: true,
        })
      }
      if (!force && isMagneticSnapActive()) {
        target = resolveRoofSegmentAtSnappedPosition(
          event.node,
          snapRoofSurfaceNodeTarget({
            target: {
              ...target,
              localX: placement.position[0],
              localY: placement.position[1],
              localZ: placement.position[2],
            },
            node: { ...seed, rotation: placement.rotation },
          }),
        )
        placement = resolveBoxVentPlacement(target.segment, seed, target.localX, target.localZ, {
          alignDownslope: true,
        })
      }
      return { target, placement, force }
    }
    const show = (event: RoofEvent) => {
      const resolved = resolve(event)
      if (!resolved) {
        clear()
        return
      }
      const { target, placement, force } = resolved
      const node = {
        ...seed,
        position: placement.position,
        rotation: placement.rotation,
        parentId: target.segment.id,
        roofSegmentId: target.segment.id,
      }
      const normal = getRoofOuterSurfaceFrameAtPoint(
        target.segment,
        placement.position[0],
        placement.position[2],
      ).normal
      setPreview({
        node,
        position: roofSegmentLocalToBuildingLocal(target.segment.id, placement.position),
        normal: surfaceQuatFromNormal(normal, new THREE.Quaternion()),
        yaw: event.node.rotation + target.segment.rotation,
        valid: placement.valid || force,
      })
      usePlacementPreview.getState().set(node, target.segment)
      publishRoofSurfaceNodePlacementGuides({
        roof: event.node,
        segment: target.segment,
        center: placement.position,
        node,
      })
      event.stopPropagation()
    }
    const place = (event: RoofEvent) => {
      const resolved = resolve(event)
      if (!resolved) return
      const { target, placement, force } = resolved
      if (!placement.valid && !force) {
        show(event)
        return
      }
      const node = BoxVentNode.parse({
        ...seed,
        id: undefined,
        roofSegmentId: target.segment.id,
        position: placement.position,
        rotation: placement.rotation,
      })
      sceneApi.upsert(node, target.segment.id as AnyNodeId)
      sceneApi.markDirty(target.segment.id as AnyNodeId)
      useViewer.getState().setSelection({ selectedIds: [node.id] })
      triggerSFX('sfx:item-place')
      clear()
      event.stopPropagation()
    }
    emitter.on('roof:move', show)
    emitter.on('roof:enter', show)
    emitter.on('roof:leave', clear)
    emitter.on('roof:click', place)
    emitter.on('tool:cancel', clear)
    return () => {
      emitter.off('roof:move', show)
      emitter.off('roof:enter', show)
      emitter.off('roof:leave', clear)
      emitter.off('roof:click', place)
      emitter.off('tool:cancel', clear)
      clear()
    }
  }, [activeBuildingId, seed, sceneApi])

  return (
    <>
      <RoofAttachmentFallbackPreview
        activeBuildingId={activeBuildingId}
        ghost={<BoxVentPreview node={seed} invalid />}
        onInvalidTarget={() => {
          setPreview(null)
          usePlacementPreview.getState().clear()
          clearRoofSurfacePlacementGuides()
        }}
      />
      {preview && (
        <group position={preview.position}>
          <group rotation-y={preview.yaw}>
            <group quaternion={preview.normal}>
              <BoxVentPreview node={preview.node} invalid={!preview.valid} />
            </group>
          </group>
        </group>
      )}
    </>
  )
}
