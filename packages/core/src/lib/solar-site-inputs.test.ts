import { describe, expect, test } from 'bun:test'
import { solarInputsFromSite, solarPosition, sunDirectionInPlan } from '../index'

describe('solar site inputs', () => {
  test('old scenes and incomplete geolocations have no solar inputs', () => {
    expect(solarInputsFromSite(undefined)).toBeUndefined()
    expect(solarInputsFromSite({})).toBeUndefined()
    expect(
      solarInputsFromSite({
        dossier: {
          provider: 'Pascal Map',
          asOf: '2026-06-01',
          sections: {},
          point: { lat: 40 },
        },
      }),
    ).toBeUndefined()
  })

  test('reads longitude-first parcel origin and converts site radians', () => {
    const inputs = solarInputsFromSite({
      parcel: { originLngLat: [-75, 40] },
      northRotation: Math.PI / 2,
    })
    expect(inputs?.latDeg).toBe(40)
    expect(inputs?.lonDeg).toBe(-75)
    expect(inputs?.northRotationDeg).toBe(90)
    expect(inputs?.northRotationRad).toBeCloseTo(Math.PI / 2, 12)

    if (!inputs) throw new Error('Expected parcel solar inputs')
    const sun = solarPosition(new Date('2026-06-21T17:00:00Z'), inputs.latDeg, inputs.lonDeg)
    expect(Number.isFinite(sun.azimuthDeg)).toBe(true)
    expect(Number.isFinite(sun.elevationDeg)).toBe(true)
    const northInPlan = sunDirectionInPlan(0, 0, inputs.northRotationRad)
    expect(northInPlan[0]).toBeCloseTo(1, 12)
    expect(northInPlan[2]).toBeCloseTo(0, 12)
  })

  test('uses the dossier point when no parcel origin exists', () => {
    const inputs = solarInputsFromSite({
      dossier: {
        provider: 'Pascal Map',
        asOf: '2026-06-01',
        sections: {},
        point: { lat: 51.5, lng: -0.12 },
      },
    })
    expect(inputs).toEqual({
      latDeg: 51.5,
      lonDeg: -0.12,
      northRotationDeg: 0,
      northRotationRad: 0,
    })
  })

  test('prefers the parcel origin to the dossier query point', () => {
    const inputs = solarInputsFromSite({
      parcel: { originLngLat: [-75, 40] },
      dossier: {
        provider: 'Pascal Map',
        asOf: '2026-06-01',
        sections: {},
        point: { lat: 41, lng: -74 },
      },
    })
    expect(inputs?.latDeg).toBe(40)
    expect(inputs?.lonDeg).toBe(-75)
  })

  test('rejects nonfinite or out-of-range parcel coordinates', () => {
    const invalid: Array<[number, number]> = [
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [0, Number.NEGATIVE_INFINITY],
      [0, 90.01],
      [0, -90.01],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [180.01, 0],
      [-180.01, 0],
    ]
    for (const originLngLat of invalid) {
      expect(() => solarInputsFromSite({ parcel: { originLngLat } })).toThrow(RangeError)
    }
  })

  test('rejects invalid dossier coordinates without emitting NaN', () => {
    expect(() =>
      solarInputsFromSite({
        dossier: {
          provider: 'Pascal Map',
          asOf: '2026-06-01',
          sections: {},
          point: { lat: 91, lng: 0 },
        },
      }),
    ).toThrow(RangeError)
  })

  test('rejects nonfinite north rotations', () => {
    for (const northRotation of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        solarInputsFromSite({ parcel: { originLngLat: [-75, 40] }, northRotation }),
      ).toThrow(RangeError)
    }
  })

  test('wraps negative and multiple-turn rotations into [0, 360) degrees', () => {
    const site = { parcel: { originLngLat: [-75, 40] as [number, number] } }
    const negative = solarInputsFromSite({ ...site, northRotation: -Math.PI / 2 })
    const doubled = solarInputsFromSite({ ...site, northRotation: 4 * Math.PI })
    expect(negative?.northRotationDeg).toBe(270)
    expect(negative?.northRotationRad).toBeCloseTo((3 * Math.PI) / 2, 12)
    expect(doubled?.northRotationDeg).toBe(0)
    expect(doubled?.northRotationRad).toBe(0)
  })

  test('accepts geodetic pole and date-line boundaries', () => {
    const inputs = solarInputsFromSite({ parcel: { originLngLat: [-180, 90] } })
    expect(inputs?.latDeg).toBe(90)
    expect(inputs?.lonDeg).toBe(-180)
    expect(
      solarInputsFromSite({ parcel: { originLngLat: [180, -90] } })?.lonDeg,
    ).toBe(180)
  })
})
