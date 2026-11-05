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

export type SolarKeyPose = {
  position: [number, number, number]
  target: [number, number, number]
  visible: boolean
}

type ThemeKeyPose = {
  position: readonly [number, number, number]
  target?: readonly [number, number, number]
}

export const VIEWER_KEY_LIGHT_NAME = 'pascal-viewer-key-light'

// A live frame may aim the key at the sun before a frame-less snapshot needs to reset it.
const solarAimedKeys = new WeakSet<object>()

export function trackSolarKeyPose(light: object, active: boolean): void {
  if (active) solarAimedKeys.add(light)
  else solarAimedKeys.delete(light)
}

/** Decide the key pose without mutating lights or changing the theme's configured direction. */
export function resolveSolarKeyPose(
  themeKey: ThemeKeyPose,
  solarLight: SolarKeyLight | null,
): SolarKeyPose {
  const [x, y, z] = themeKey.position
  const [tx, ty, tz] = themeKey.target ?? [0, 0, 0]
  const direction = solarLight?.direction

  if (!direction || !direction.every(Number.isFinite) || Math.hypot(...direction) === 0) {
    return { position: [x, y, z], target: [tx, ty, tz], visible: true }
  }

  const distance = Math.hypot(x - tx, y - ty, z - tz) || 100
  return {
    position: [
      tx + direction[0] * distance,
      ty + direction[1] * distance,
      tz + direction[2] * distance,
    ],
    target: [tx, ty, tz],
    visible: solarLight.visible,
  }
}

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
  const direction = sunDirectionInPlan(azimuthDeg, elevationDeg, northRotation)
  if (!Number.isFinite(elevationDeg) || !direction.every(Number.isFinite)) return null

  return { direction, visible: elevationDeg >= 0 }
}

/** Refresh the viewer's key for offline captures that do not advance the R3F frame. */
export function applySnapshotSolarKeyLight(
  scene: Scene,
  study: SolarStudy | null,
  themeKey?: ThemeKeyPose,
): void {
  if (getKeyLightDirectionOverride()) return
  const solarLight = resolveSolarKeyLight(study)
  const key = scene.getObjectByName(VIEWER_KEY_LIGHT_NAME)
  if (!(key instanceof DirectionalLight)) return

  if (!solarLight) {
    // Never disturb legacy frames unless a live frame or capture first aimed this key at the sun.
    if (!themeKey || !solarAimedKeys.has(key)) return
    const pose = resolveSolarKeyPose(themeKey, null)
    key.position.set(...pose.position)
    key.target.position.set(...pose.target)
    key.target.updateMatrixWorld()
    key.visible = pose.visible
    trackSolarKeyPose(key, false)
    return
  }

  const distance = key.position.distanceTo(key.target.position) || 1
  key.position.set(...solarLight.direction).multiplyScalar(distance).add(key.target.position)
  key.visible = solarLight.visible
  trackSolarKeyPose(key, true)
}
