// @ts-expect-error — Bun types are not part of the viewer's production declaration build.
import { expect, test } from 'bun:test'
import { resolveSolarKeyLight } from '../index'

const summerNoon = new Date('2026-06-21T17:00:00Z')
const summerSite = { lat: 40, lng: -75, northRotation: 0 }

test('a known summer-solstice instant aims the key toward the elevated southern sun', () => {
  const light = resolveSolarKeyLight({ date: summerNoon, site: summerSite })
  expect(light?.visible).toBe(true)
  // NOAA at 40° N / 75° W: azimuth 178.89°, elevation 73.45°.
  // x = cos(73.45°) sin(178.89°), y = sin(73.45°), z = -cos(73.45°) cos(178.89°).
  expect(light?.direction[0]).toBeCloseTo(0.0055, 2)
  expect(light?.direction[1]).toBeCloseTo(0.959, 2)
  expect(light?.direction[2]).toBeCloseTo(0.285, 2)
})

test('clockwise site north rotation turns the horizontal key without changing elevation', () => {
  const baseline = resolveSolarKeyLight({ date: summerNoon, site: summerSite })
  const rotated = resolveSolarKeyLight({
    date: summerNoon,
    site: { ...summerSite, northRotation: Math.PI / 2 },
  })
  expect(baseline).not.toBeNull()
  expect(rotated).not.toBeNull()
  if (!baseline || !rotated) throw new Error('Expected a valid solar light')

  expect(rotated.direction[0]).toBeCloseTo(-baseline.direction[2], 12)
  expect(rotated.direction[1]).toBeCloseTo(baseline.direction[1], 12)
  expect(rotated.direction[2]).toBeCloseTo(baseline.direction[0], 12)
  expect(Math.hypot(...rotated.direction)).toBeCloseTo(1, 12)
})

test('polar night hides the key rather than shining it up from below the ground', () => {
  const light = resolveSolarKeyLight({
    date: new Date('2026-12-21T12:00:00Z'),
    site: { lat: 80, lng: 0 },
  })
  expect(light?.visible).toBe(false)
  expect(Math.hypot(...(light?.direction ?? [0, 0, 0]))).toBeCloseTo(1, 12)
})

test('equivalent UTC instants yield the same key', () => {
  expect(resolveSolarKeyLight({ date: summerNoon, site: summerSite })).toEqual(
    resolveSolarKeyLight({
      date: new Date('2026-06-21T13:00:00-04:00'),
      site: summerSite,
    }),
  )
})

test('missing or invalid site data does not replace the existing theme light', () => {
  expect(resolveSolarKeyLight(null)).toBeNull()
  expect(resolveSolarKeyLight({ date: summerNoon, site: {} })).toBeNull()
  expect(resolveSolarKeyLight({ date: summerNoon, site: { lat: 91, lng: 0 } })).toBeNull()
  expect(resolveSolarKeyLight({ date: summerNoon, site: { lat: 40, lng: Infinity } })).toBeNull()
  expect(
    resolveSolarKeyLight({ date: new Date(NaN), site: { lat: 40, lng: -75 } }),
  ).toBeNull()
})
