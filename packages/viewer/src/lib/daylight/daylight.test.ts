// @ts-expect-error — Bun types are not part of the viewer's production declaration build.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { SiteNode } from '@pascal-app/core'
import { presetInstant, solarLight, solarPosition } from '@pascal-app/viewer'
import { resolveLocation, siteLocation, timezoneLocation } from './location'

const PARIS = { lat: 48.86, lng: 2.35 }
const JUNE = new Date(Date.UTC(2026, 5, 21))

describe('solar position', () => {
  test('published solar day ignores the host timezone', () => {
    const probe = `
      import { presetInstant, solarClockInstant, solarClockMinutes, sunEvents } from '@pascal-app/viewer'
      const day = new Date('2026-06-21T00:00:00.000Z')
      const lat = 48.86
      const lng = 2.35
      const noon = solarClockInstant(day, lng, 720)
      process.stdout.write(JSON.stringify({
        noon: noon.toISOString(),
        preset: presetInstant(day, lat, lng, 'midday').toISOString(),
        minutes: solarClockMinutes(noon, lng),
        events: sunEvents(day, lat, lng),
      }))
    `
    const inTimezone = (tz: string) => {
      const child = spawnSync(process.execPath, ['-e', probe], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
      })
      expect(child.status).toBe(0)
      return JSON.parse(child.stdout)
    }

    const utc = inTimezone('UTC')
    expect(inTimezone('Etc/GMT+5')).toEqual(utc)
    expect(utc.noon).toBe('2026-06-21T11:50:36.000Z')
    expect(utc.minutes).toBeCloseTo(720, 8)
  })

  test('Paris at the June solstice: high noon sun due south', () => {
    const noon = presetInstant(JUNE, PARIS.lat, PARIS.lng, 'midday')
    const { azimuth, elevation } = solarPosition(noon, PARIS.lat, PARIS.lng)
    expect(elevation).toBeGreaterThan(64)
    expect(elevation).toBeLessThan(65.5)
    expect(Math.abs(azimuth - 180)).toBeLessThan(3)
  })

  test('presets land on their sun elevation in the evening', () => {
    const noon = presetInstant(JUNE, PARIS.lat, PARIS.lng, 'midday').getTime()
    for (const [preset, target] of [
      ['golden', 6],
      ['blue', -4],
      ['night', -14],
    ] as const) {
      const when = presetInstant(JUNE, PARIS.lat, PARIS.lng, preset)
      expect(when.getTime()).toBeGreaterThan(noon)
      expect(Math.abs(solarPosition(when, PARIS.lat, PARIS.lng).elevation - target)).toBeLessThan(1)
    }
  })

  test('polar summer falls back to the lowest sun instead of failing', () => {
    const tromso = { lat: 69.65, lng: 18.96 }
    const when = presetInstant(JUNE, tromso.lat, tromso.lng, 'night')
    const { elevation } = solarPosition(when, tromso.lat, tromso.lng)
    expect(Number.isFinite(elevation)).toBe(true)
    expect(elevation).toBeGreaterThan(-1)
  })

  test('north rotation turns the sun direction with the plan', () => {
    const noon = presetInstant(JUNE, PARIS.lat, PARIS.lng, 'midday')
    const plain = solarLight(noon, PARIS.lat, PARIS.lng, 0)
    // South is plan +z with true north along plan −z.
    expect(plain.direction.z).toBeGreaterThan(0.4)
    const turned = solarLight(noon, PARIS.lat, PARIS.lng, Math.PI / 2)
    expect(turned.direction.x).toBeLessThan(-0.4)
    expect(plain.night).toBe(0)
  })

  test('published solar light honors persisted site north rotation', () => {
    const noon = presetInstant(JUNE, PARIS.lat, PARIS.lng, 'midday')
    const lightForSite = (northRotation?: number) => {
      const site = SiteNode.parse({ northRotation })
      const restored = SiteNode.parse(JSON.parse(JSON.stringify(site)))
      expect(restored.northRotation).toBe(northRotation)
      return solarLight(noon, PARIS.lat, PARIS.lng, restored.northRotation ?? 0)
    }

    const zero = lightForSite(0)
    const thirty = lightForSite(Math.PI / 6)
    const ninety = lightForSite(Math.PI / 2)
    const legacy = lightForSite()
    expect(legacy.direction.toArray()).toEqual(zero.direction.toArray())

    const cos30 = Math.sqrt(3) / 2
    expect(thirty.direction.x).toBeCloseTo(zero.direction.x * cos30 - zero.direction.z / 2, 10)
    expect(thirty.direction.z).toBeCloseTo(zero.direction.x / 2 + zero.direction.z * cos30, 10)
    expect(ninety.direction.x).toBeCloseTo(-zero.direction.z, 10)
    expect(ninety.direction.z).toBeCloseTo(zero.direction.x, 10)
    expect(thirty.direction.y).toBeCloseTo(zero.direction.y, 10)
    expect(ninety.direction.y).toBeCloseTo(zero.direction.y, 10)
  })

  test('the sun warms and fades towards the horizon', () => {
    const golden = solarLight(
      presetInstant(JUNE, PARIS.lat, PARIS.lng, 'golden'),
      PARIS.lat,
      PARIS.lng,
      0,
    )
    const noon = solarLight(
      presetInstant(JUNE, PARIS.lat, PARIS.lng, 'midday'),
      PARIS.lat,
      PARIS.lng,
      0,
    )
    expect(golden.color.b).toBeLessThan(noon.color.b)
    expect(golden.strength).toBeLessThan(noon.strength)
    const night = solarLight(
      presetInstant(JUNE, PARIS.lat, PARIS.lng, 'night'),
      PARIS.lat,
      PARIS.lng,
      0,
    )
    expect(night.strength).toBe(0)
    expect(night.night).toBe(1)
  })
})

describe('location', () => {
  test('the site point wins, parcel origin before dossier point', () => {
    expect(siteLocation({ parcel: { originLngLat: [2.35, 48.86] } })).toEqual(PARIS)
    expect(siteLocation({ dossier: { point: { lat: 1, lng: 2 } } })).toEqual({ lat: 1, lng: 2 })
    expect(siteLocation({ parcel: { originLngLat: null }, dossier: { point: null } })).toBeNull()
    expect(
      resolveLocation({ parcel: { originLngLat: [2.35, 48.86] } }, { lat: 0, lng: 0 }),
    ).toEqual({
      location: PARIS,
      source: 'site',
    })
  })

  test('a granted device location comes before the timezone guess', () => {
    expect(resolveLocation(null, { lat: 10, lng: 20 })).toEqual({
      location: { lat: 10, lng: 20 },
      source: 'device',
    })
    expect(['timezone', 'default']).toContain(resolveLocation(null, null).source)
  })

  test('timezone guesses only known zones', () => {
    expect(timezoneLocation('Europe/Paris')).toEqual(PARIS)
    expect(timezoneLocation('Antarctica/Troll')).toBeNull()
  })
})
