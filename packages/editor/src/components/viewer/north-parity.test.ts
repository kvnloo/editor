import { describe, expect, test } from 'bun:test'
import * as core from '@pascal-app/core'
import { FloorplanPreview } from '@pascal-app/editor'
import * as viewer from '@pascal-app/viewer'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const THIRTY_DEGREES = Math.PI / 6
const NORTH_FACING_LOT: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 20],
  [0, 20],
]

type Site = ReturnType<typeof core.SiteNode.parse>

function savedNorthRotation(site: Site): number {
  return (site as Site & { northRotation?: number }).northRotation ?? 0
}

function previewCompassRotation(site: Site): number | undefined {
  const building = core.BuildingNode.parse({ parentId: site.id })
  const level = core.LevelNode.parse({ parentId: building.id })
  const nodes = {
    [site.id]: core.SiteNode.parse({ ...site, children: [building.id] }),
    [building.id]: core.BuildingNode.parse({ ...building, children: [level.id] }),
    [level.id]: level,
  }
  const markup = renderToStaticMarkup(
    createElement(FloorplanPreview, {
      levelId: level.id,
      scene: { nodes },
      showLevelSelector: false,
    }),
  )
  const needle = markup.match(/<svg[^>]*style="transform:rotate\((-?\d+(?:\.\d+)?)deg\)"/)
  return needle ? Number(needle[1]) : undefined
}

describe('site north is one contract for plan, compass and sun', () => {
  test('a scene saved without a north field retains the zero-heading convention', () => {
    const site = core.SiteNode.parse({ type: 'site' })
    const loaded = core.SiteNode.parse(JSON.parse(JSON.stringify(site)))

    expect(savedNorthRotation(loaded)).toBe(0)
    expect(previewCompassRotation(loaded)).toBe(0)
  })

  test('a saved 30-degree radian heading survives a scene JSON round trip', () => {
    const site = core.SiteNode.parse({ type: 'site', northRotation: THIRTY_DEGREES })
    const loaded = core.SiteNode.parse(JSON.parse(JSON.stringify(site)))

    expect(savedNorthRotation(loaded)).toBeCloseTo(THIRTY_DEGREES, 12)
  })

  test('a 30-degree site north rotates the published plan compass, not the site geometry', () => {
    const site = core.SiteNode.parse({ type: 'site', northRotation: THIRTY_DEGREES })

    expect(previewCompassRotation(site)).toBe(30)
    expect(site.polygon.points).toEqual([
      [-15, -15],
      [15, -15],
      [15, 15],
      [-15, 15],
    ])
  })

  test('the site-plan north-facing edge bears 330 degrees under a 30-degree north offset', () => {
    const site = core.SiteNode.parse({ type: 'site', northRotation: THIRTY_DEGREES })
    const publicCore = core as unknown as {
      edgeHeadingDeg?: (points: readonly [number, number][], i: number, north: number) => number
    }

    const bearing = publicCore.edgeHeadingDeg?.(NORTH_FACING_LOT, 0, savedNorthRotation(site))
    expect(bearing).toBeCloseTo(330, 9)
  })

  test('solar direction rotates with the same 30-degree site north without changing elevation', () => {
    const site = core.SiteNode.parse({ type: 'site', northRotation: THIRTY_DEGREES })
    const publicViewer = viewer as unknown as {
      resolveSolarKeyLight?: (study: {
        date: Date
        site: { lat: number; lng: number; northRotation: number }
      }) => { direction: [number, number, number] } | null
    }
    const date = new Date('2026-06-21T17:00:00Z')
    const location = { lat: 40, lng: -75 }
    const baseline = publicViewer.resolveSolarKeyLight?.({
      date,
      site: { ...location, northRotation: 0 },
    })
    const rotated = publicViewer.resolveSolarKeyLight?.({
      date,
      site: { ...location, northRotation: savedNorthRotation(site) },
    })

    expect(baseline?.direction).toHaveLength(3)
    expect(rotated?.direction).toHaveLength(3)
    if (!baseline || !rotated) throw new Error('A valid solar study must resolve a direction')

    const [x, y, z] = baseline.direction
    const [turnedX, turnedY, turnedZ] = rotated.direction
    expect(turnedX).toBeCloseTo(x * Math.cos(THIRTY_DEGREES) - z * Math.sin(THIRTY_DEGREES), 8)
    expect(turnedY).toBeCloseTo(y, 8)
    expect(turnedZ).toBeCloseTo(x * Math.sin(THIRTY_DEGREES) + z * Math.cos(THIRTY_DEGREES), 8)
  })
})
