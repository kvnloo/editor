import type { SiteNode } from '../schema/nodes/site'

const FULL_TURN_RAD = 2 * Math.PI
const DEGREES_PER_RADIAN = 180 / Math.PI

export type SolarSiteInputs = {
  latDeg: number
  lonDeg: number
  northRotationDeg: number
  northRotationRad: number
}

/** A missing site or geolocation returns undefined; invalid present values are rejected. */
export function solarInputsFromSite(
  site: Pick<SiteNode, 'dossier' | 'parcel' | 'northRotation'> | null | undefined,
): SolarSiteInputs | undefined {
  // The parcel origin tracks the plan polygon; the dossier point is the fallback.
  // Parcel coordinates are stored longitude first.
  let origin = site?.parcel?.originLngLat
  if (!origin) {
    const point = site?.dossier?.point
    if (point?.lat !== undefined && point?.lng !== undefined) {
      origin = [point.lng, point.lat]
    }
  }
  if (!origin) return undefined

  const [lonDeg, latDeg] = origin
  if (!Number.isFinite(latDeg) || Math.abs(latDeg) > 90) {
    throw new RangeError('Site latitude must be finite and between -90 and 90 degrees')
  }
  if (!Number.isFinite(lonDeg) || Math.abs(lonDeg) > 180) {
    throw new RangeError('Site longitude must be finite and between -180 and 180 degrees')
  }

  // SiteNode stores clockwise radians from plan -z. Wrap in radians first to
  // avoid overflow when converting a large but finite angle to degrees.
  const rotation = site?.northRotation ?? 0
  if (!Number.isFinite(rotation)) {
    throw new RangeError('Site north rotation must be finite')
  }
  const northRotationRad = ((rotation % FULL_TURN_RAD) + FULL_TURN_RAD) % FULL_TURN_RAD
  const northRotationDeg = (northRotationRad * DEGREES_PER_RADIAN) % 360

  return { latDeg, lonDeg, northRotationDeg, northRotationRad }
}
