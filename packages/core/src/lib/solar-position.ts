const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const MS_PER_DAY = 86_400_000

export type SolarPosition = { azimuthDeg: number; elevationDeg: number }

/** Sun angles at a UTC instant: azimuth clockwise from true north, geometric elevation above the horizon. */
export function solarPosition(date: Date, latDeg: number, lonDeg: number): SolarPosition {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('Solar position requires a valid Date')
  }
  if (!Number.isFinite(latDeg) || Math.abs(latDeg) > 90) {
    throw new RangeError('Latitude must be finite and between -90 and 90 degrees')
  }
  if (!Number.isFinite(lonDeg) || Math.abs(lonDeg) > 180) {
    throw new RangeError('Longitude must be finite and between -180 and 180 degrees')
  }

  const year = date.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const dayOfYear = Math.floor((date.getTime() - yearStart) / MS_PER_DAY) + 1
  const daysInYear = (Date.UTC(year + 1, 0, 1) - yearStart) / MS_PER_DAY
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000

  // NOAA's fractional-year approximation keeps offline sun studies deterministic: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
  const gamma = ((2 * Math.PI) / daysInYear) * (dayOfYear - 1 + (utcMinutes / 60 - 12) / 24)
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma))
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma)

  const trueSolarMinutes = (((utcMinutes + equationOfTime + 4 * lonDeg) % 1440) + 1440) % 1440
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG_TO_RAD
  const latitude = latDeg * DEG_TO_RAD
  const sinElevation =
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
  const elevationDeg = Math.asin(Math.max(-1, Math.min(1, sinElevation))) * RAD_TO_DEG

  // atan2 preserves the morning/afternoon azimuth quadrant without dividing by sin(zenith).
  const azimuthDeg =
    (Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(latitude) -
        Math.tan(declination) * Math.cos(latitude),
    ) *
      RAD_TO_DEG +
      540) %
    360

  return { azimuthDeg, elevationDeg }
}

/** Unit vector toward the sun in Pascal's y-up frame: plan -z is north before rotation. */
export function sunDirectionInPlan(
  azimuthDeg: number,
  elevationDeg: number,
  northRotation: number,
): [number, number, number] {
  const azimuthInPlan = azimuthDeg * DEG_TO_RAD + northRotation
  const elevation = elevationDeg * DEG_TO_RAD
  const horizontal = Math.cos(elevation)
  return [
    horizontal * Math.sin(azimuthInPlan),
    Math.sin(elevation),
    -horizontal * Math.cos(azimuthInPlan),
  ]
}
