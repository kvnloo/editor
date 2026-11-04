import { solarPosition, sunDirectionInPlan } from '@pascal-app/core'

export type SolarStudy = {
  date: Date
  site: { lat?: number; lng?: number; northRotation?: number }
}

export type SolarKeyLight = {
  direction: [number, number, number]
  visible: boolean
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
  return {
    direction: sunDirectionInPlan(azimuthDeg, elevationDeg, northRotation),
    visible: elevationDeg >= 0,
  }
}
