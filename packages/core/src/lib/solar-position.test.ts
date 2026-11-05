import { describe, expect, test } from 'bun:test'
import { solarPosition, sunDirectionInPlan } from '../index'

describe('solar position', () => {
  test('rejects an invalid Date', () => {
    expect(() => solarPosition(new Date(Number.NaN), 0, 0)).toThrow(RangeError)
  })

  test('rejects nonfinite latitudes', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const latitude of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => solarPosition(instant, latitude, 0)).toThrow(RangeError)
    }
  })

  test('rejects out-of-range latitudes', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const latitude of [-90.0001, 90.0001]) {
      expect(() => solarPosition(instant, latitude, 0)).toThrow(RangeError)
    }
  })

  test('rejects nonfinite longitudes', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const longitude of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => solarPosition(instant, 0, longitude)).toThrow(RangeError)
    }
  })

  test('rejects out-of-range longitudes', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const longitude of [-180.0001, 180.0001]) {
      expect(() => solarPosition(instant, 0, longitude)).toThrow(RangeError)
    }
  })

  test('accepts both poles with finite angles', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const latitude of [-90, 90]) {
      const sun = solarPosition(instant, latitude, 0)
      expect(Number.isFinite(sun.azimuthDeg)).toBe(true)
      expect(Number.isFinite(sun.elevationDeg)).toBe(true)
    }
  })

  test('accepts both sides of the date line with finite angles', () => {
    const instant = new Date('2026-06-21T17:00:00Z')
    for (const longitude of [-180, 180]) {
      const sun = solarPosition(instant, 0, longitude)
      expect(Number.isFinite(sun.azimuthDeg)).toBe(true)
      expect(Number.isFinite(sun.elevationDeg)).toBe(true)
    }
  })

  test('the equinox sun is within one degree of overhead at the equator around solar noon', () => {
    // 2026-03-20 12:07 UTC, latitude 0, longitude 0: NOAA-equation elevation ~89.46°.
    const sun = solarPosition(new Date('2026-03-20T12:07:00Z'), 0, 0)
    expect(Math.abs(90 - sun.elevationDeg)).toBeLessThan(1)
  })

  test('matches the NOAA summer-solstice reference at 40° N, 75° W', () => {
    // 2026-06-21 17:00 UTC, lat 40, lon -75: NOAA equations give
    // time equation -1.374 min, declination 23.453°, hour angle -0.343°;
    // azimuth 178.89° clockwise from true north, geometric elevation 73.45°.
    const sun = solarPosition(new Date('2026-06-21T17:00:00Z'), 40, -75)
    expect(Math.abs(sun.azimuthDeg - 178.89)).toBeLessThan(0.5)
    expect(Math.abs(sun.elevationDeg - 73.45)).toBeLessThan(0.5)
  })

  test('the winter-solstice sun stays below the horizon at 80° N', () => {
    // 2026-12-21 12:00 UTC, lat 80, lon 0: NOAA-equation elevation ~-13.42°.
    const sun = solarPosition(new Date('2026-12-21T12:00:00Z'), 80, 0)
    expect(sun.elevationDeg).toBeLessThan(0)
  })

  test('uses the UTC instant rather than the date string timezone', () => {
    const utc = solarPosition(new Date('2026-06-21T17:00:00Z'), 40, -75)
    const local = solarPosition(new Date('2026-06-21T13:00:00-04:00'), 40, -75)
    expect(local).toEqual(utc)
  })
})

describe('sun direction in Pascal plan coordinates', () => {
  test('due south on the horizon points toward positive z', () => {
    const direction = sunDirectionInPlan(180, 0, 0)
    expect(direction[0]).toBeCloseTo(0, 12)
    expect(direction[1]).toBeCloseTo(0, 12)
    expect(direction[2]).toBeCloseTo(1, 12)
  })

  test('a clockwise quarter-turn of true north points north toward positive x', () => {
    const direction = sunDirectionInPlan(0, 0, Math.PI / 2)
    expect(direction[0]).toBeCloseTo(1, 12)
    expect(direction[1]).toBeCloseTo(0, 12)
    expect(direction[2]).toBeCloseTo(0, 12)
  })

  test('keeps the direction normalized at arbitrary angles', () => {
    const direction = sunDirectionInPlan(125, 37, 0.42)
    expect(Math.hypot(...direction)).toBeCloseTo(1, 12)
  })
})
