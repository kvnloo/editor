import { expect, test } from 'bun:test'
import { DirectionalLight, Scene } from 'three'
import {
  applySnapshotSolarKeyLight,
  resolveSolarKeyLight,
  resolveSolarKeyPose,
  VIEWER_KEY_LIGHT_NAME,
} from '../index'

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

test('snapshot syncs the live NOAA solar direction without needing an animation frame', () => {
  const study = { date: summerNoon, site: summerSite }
  const live = resolveSolarKeyLight(study)
  if (!live) throw new Error('Expected a valid summer sun')

  const scene = new Scene()
  const key = new DirectionalLight()
  key.name = VIEWER_KEY_LIGHT_NAME
  key.position.set(12, 13, 4)
  key.target.position.set(2, 3, -6)
  scene.add(key)
  const fill = new DirectionalLight()
  fill.position.set(-1, 5, -2)
  scene.add(fill)
  const distance = key.position.distanceTo(key.target.position)

  applySnapshotSolarKeyLight(scene, study)
  const captured = key.position.clone().sub(key.target.position).normalize()
  // NOAA, 2026-06-21 17:00 UTC at 40 N, -75 E: azimuth 178.89°, elevation 73.45°.
  expect(captured.x).toBeCloseTo(0.0055, 3)
  expect(captured.y).toBeCloseTo(0.959, 3)
  expect(captured.z).toBeCloseTo(0.285, 3)
  expect(captured.x).toBeCloseTo(live.direction[0], 12)
  expect(captured.y).toBeCloseTo(live.direction[1], 12)
  expect(captured.z).toBeCloseTo(live.direction[2], 12)
  expect(key.position.distanceTo(key.target.position)).toBeCloseTo(distance, 12)
  expect(key.visible).toBe(live.visible)
  expect(key.target.position.toArray()).toEqual([2, 3, -6])
  expect(fill.position.toArray()).toEqual([-1, 5, -2])
})

test('sun study enable and disable restores the exact theme pose and direction', () => {
  const themeKey = { position: [-18, 35, 20], target: [2, 3, -6] } as const
  const originalDirection = [-20, 32, 26]
  const sun = resolveSolarKeyLight({ date: summerNoon, site: summerSite })
  if (!sun) throw new Error('Expected a valid summer sun')

  const studied = resolveSolarKeyPose(themeKey, sun)
  expect(studied.position).not.toEqual(themeKey.position)
  expect(studied.visible).toBe(true)

  const restored = resolveSolarKeyPose(themeKey, null)
  expect(restored).toEqual({
    position: [-18, 35, 20],
    target: [2, 3, -6],
    visible: true,
  })
  expect(restored.position.map((value, index) => value - restored.target[index]!)).toEqual(
    originalDirection,
  )
  expect(themeKey.position).toEqual([-18, 35, 20])
})

test('invalid study data and nonfinite solar vectors use the theme pose', () => {
  const themeKey = { position: [8, 12, -5], target: [1, 2, 3] } as const
  const themePose = resolveSolarKeyPose(themeKey, null)
  expect(
    resolveSolarKeyPose(
      themeKey,
      resolveSolarKeyLight({ date: summerNoon, site: { lat: NaN, lng: -75 } }),
    ),
  ).toEqual(themePose)
  expect(resolveSolarKeyPose(themeKey, { direction: [NaN, 0, 0], visible: true })).toEqual(
    themePose,
  )
  expect(resolveSolarKeyPose(themeKey, { direction: [Infinity, 0, 0], visible: true })).toEqual(
    themePose,
  )
})

test('snapshot resets a previously studied key but leaves never-studied scenes unchanged', () => {
  const themeKey = { position: [-18, 35, 20], target: [2, 3, -6] } as const
  const scene = new Scene()
  const key = new DirectionalLight()
  key.name = VIEWER_KEY_LIGHT_NAME
  key.position.set(30, 45, 50)
  key.target.position.set(4, 5, 6)
  scene.add(key)
  const legacyPosition = key.position.toArray()

  applySnapshotSolarKeyLight(scene, null, themeKey)
  expect(key.position.toArray()).toEqual(legacyPosition)
  expect(key.target.position.toArray()).toEqual([4, 5, 6])

  const valid = { date: summerNoon, site: summerSite }
  applySnapshotSolarKeyLight(scene, valid, themeKey)
  expect(key.position.toArray()).not.toEqual(legacyPosition)
  applySnapshotSolarKeyLight(scene, null, themeKey)
  expect(key.position.toArray()).toEqual([-18, 35, 20])
  expect(key.target.position.toArray()).toEqual([2, 3, -6])
  expect(key.visible).toBe(true)

  applySnapshotSolarKeyLight(scene, valid, themeKey)
  applySnapshotSolarKeyLight(scene, { date: new Date(NaN), site: summerSite }, themeKey)
  expect(key.position.toArray()).toEqual([-18, 35, 20])
  expect(key.target.position.toArray()).toEqual([2, 3, -6])
  expect(key.visible).toBe(true)
})
