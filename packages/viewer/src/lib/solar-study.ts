import { solarPosition, sunDirectionInPlan } from '@pascal-app/core'
import { DirectionalLight, type Scene } from 'three'
import { getKeyLightDirectionOverride } from './key-light-override'

export type SolarStudy = {
  date: Date
  site: { lat?: number; lng?: number; northRotation?: number }
}

export type SolarKeyLight = {
  direction: [number, number, number]
  visible: boolean
}

export const VIEWER_KEY_LIGHT_NAME = 'pascal-viewer-key-light'

/** Resolve a site's true-north sun to a direction toward the sun in Pascal's world frame. */
export function resolveSolarKeyLight(study: SolarStudy | null): SolarKeyLight | null {
  if (!study?.site || !(study.date instanceof Date) || !Number.isFinite(study.date.getTime()))
    return null

  const { lat, lng, northRotation = 0 } = study.site
  if (
    lat === undefined ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90 ||
    lng === undefined ||
    !Number.isFinite(lng) ||
    Math.abs(lng) > 180 ||
    !Number.isFinite(northRotation)
  )
    return null

  const { azimuthDeg, elevationDeg } = solarPosition(study.date, lat, lng)
  return {
    direction: sunDirectionInPlan(azimuthDeg, elevationDeg, northRotation),
    visible: elevationDeg >= 0,
  }
}

/** Refresh the viewer's key for offline captures that do not advance the R3F frame. */
export function applySnapshotSolarKeyLight(scene: Scene, study: SolarStudy | null): void {
  if (getKeyLightDirectionOverride()) return
  const solarLight = resolveSolarKeyLight(study)
  if (!solarLight) return

  const key = scene.getObjectByName(VIEWER_KEY_LIGHT_NAME)
  if (!(key instanceof DirectionalLight)) return

  const distance = key.position.distanceTo(key.target.position) || 1
  key.position.set(...solarLight.direction).multiplyScalar(distance).add(key.target.position)
  key.visible = solarLight.visible
}
