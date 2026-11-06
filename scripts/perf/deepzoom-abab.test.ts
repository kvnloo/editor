import { describe, expect, test } from 'bun:test'
import {
  nearestRankPercentile,
  normalizeViewportTape,
  summarizeDeepzoomAbab,
} from './deepzoom-abab.mjs'

type Step = { atMs: number; zoomPx: number; panXPx: number; panYPx: number }
type Run = {
  arm: 'A' | 'B'
  cache: 'cold' | 'warm'
  sourceUrl: string
  devicePixelRatio: number
  tape: Step[]
  frameMs: number[]
  timeToSharpMs: number | null
  timingOrigin: 'browser' | 'simulated'
  backendReceipt?: {
    backend: 'webgl' | 'webgpu' | 'canvas2d' | 'html'
    capturedAt: string
  } | null
}
type Input = { schemaVersion: 1; sourceUrl: string; runs: Run[] }

const sourceUrl = 'https://example.test/twin/scene.dzi?signature=signed'
const cssTape: Step[] = [
  { atMs: 0, zoomPx: 1, panXPx: 10, panYPx: -2 },
  { atMs: 80, zoomPx: 2, panXPx: 30, panYPx: 6 },
]

function fixture(): Input {
  const runs: Run[] = []
  for (const cache of ['cold', 'warm'] as const) {
    for (const [index, arm] of (['A', 'B', 'A', 'B'] as const).entries()) {
      const devicePixelRatio = arm === 'A' ? 1 : 2
      const isColdA = cache === 'cold' && arm === 'A'
      const frameMs = isColdA
        ? index === 0
          ? [10, 20]
          : [30, 40]
        : cache === 'warm'
          ? [110 + index * 10, 120 + index * 10]
          : [5 + index, 7 + index]

      runs.push({
        arm,
        cache,
        sourceUrl,
        devicePixelRatio,
        tape: cssTape.map((step) => ({
          atMs: step.atMs,
          zoomPx: step.zoomPx * devicePixelRatio,
          panXPx: step.panXPx * devicePixelRatio,
          panYPx: step.panYPx * devicePixelRatio,
        })),
        frameMs,
        timeToSharpMs: isColdA ? (index === 0 ? 90 : 110) : 150 + index,
        timingOrigin: 'browser',
        backendReceipt: { backend: 'webgl', capturedAt: '2026-11-04T12:00:00Z' },
      })
    }
  }
  return { schemaVersion: 1, sourceUrl, runs }
}

describe('same-asset deep-zoom ABAB report', () => {
  test('replays one timed zoom/pan tape normalized to DPR=1 across different displays', () => {
    const input = fixture()
    const report = summarizeDeepzoomAbab(input)

    expect(report.sourceUrl).toBe(sourceUrl)
    expect(report.normalizedDpr).toBe(1)
    expect(report.tape).toEqual([
      { atMs: 0, zoom: 1, panX: 10, panY: -2 },
      { atMs: 80, zoom: 2, panX: 30, panY: 6 },
    ])
    expect(report.results.map((bucket) => [bucket.cache, bucket.arm])).toEqual([
      ['cold', 'A'],
      ['cold', 'B'],
      ['warm', 'A'],
      ['warm', 'B'],
    ])
    expect(report.results[0]?.devicePixelRatios).toEqual([1, 1])
    expect(report.results[1]?.devicePixelRatios).toEqual([2, 2])
    expect(input.runs[1]?.tape[0]?.zoomPx).toBe(2)
  })

  test('rejects a different signed DZI source URL in any run', () => {
    const input = fixture()
    input.runs[3]!.sourceUrl = sourceUrl.replace('signed', 'different')
    expect(() => summarizeDeepzoomAbab(input)).toThrow('different source URL')
  })

  test('rejects a different pan, zoom, or event timestamp after DPR normalization', () => {
    const input = fixture()
    input.runs[1]!.tape[1]!.panXPx += 2
    expect(() => summarizeDeepzoomAbab(input)).toThrow('different zoom/pan tape')

    const timing = fixture()
    timing.runs[7]!.tape[1]!.atMs = 81
    expect(() => summarizeDeepzoomAbab(timing)).toThrow('different zoom/pan tape')

    const zoom = fixture()
    zoom.runs[2]!.tape[0]!.zoomPx = 1.25
    expect(() => summarizeDeepzoomAbab(zoom)).toThrow('different zoom/pan tape')
  })

  test('requires two ABAB sweeps with cold and warm cache samples separate', () => {
    const input = fixture()
    ;[input.runs[0], input.runs[1]] = [input.runs[1]!, input.runs[0]!]
    expect(() => summarizeDeepzoomAbab(input)).toThrow('in ABAB order')

    const report = summarizeDeepzoomAbab(fixture())
    expect(report.results[0]?.frameMs).toEqual({ p50: 20, p95: 40 })
    expect(report.results[2]?.frameMs).toEqual({ p50: 120, p95: 140 })
    expect(report.cacheEvidence).toBe('declared-not-verified')
  })

  test('uses nearest-rank percentiles and reports time-to-sharp independently', () => {
    expect(nearestRankPercentile([40, 10, 30, 20], 50)).toBe(20)
    expect(nearestRankPercentile([40, 10, 30, 20], 95)).toBe(40)

    const coldA = summarizeDeepzoomAbab(fixture()).results[0]
    expect(coldA?.frameCount).toBe(4)
    expect(coldA?.frameMs).toEqual({ p50: 20, p95: 40 })
    expect(coldA?.timeToSharpMs).toEqual({ p50: 90, p95: 110 })
  })

  test('preserves unknown when a backend receipt is absent', () => {
    const input = fixture()
    input.runs[2]!.backendReceipt = null
    const coldA = summarizeDeepzoomAbab(input).results[0]

    expect(coldA?.backend).toBe('unknown')
    expect(coldA?.timingEvidence).toBe('unknown')
    expect(coldA?.gpuEvidence).toBe('unknown')
  })

  test('labels simulated timings as simulated, not a real GPU measurement', () => {
    const input = fixture()
    input.runs[4]!.timingOrigin = 'simulated'
    input.runs[4]!.backendReceipt = {
      backend: 'webgpu',
      capturedAt: '2026-11-04T12:00:00Z',
    }
    const warmA = summarizeDeepzoomAbab(input).results[2]

    expect(warmA?.timingEvidence).toBe('simulated')
    expect(warmA?.backend).toBe('unknown')
    expect(warmA?.gpuEvidence).toBe('unknown')
    expect(warmA?.frameMs.p95).toBe(140)
  })

  test('does not turn an unknown time-to-sharp into zero or a partial percentile', () => {
    const input = fixture()
    input.runs[2]!.timeToSharpMs = null
    expect(summarizeDeepzoomAbab(input).results[0]?.timeToSharpMs).toEqual({
      p50: null,
      p95: null,
    })
  })

  test('rejects missing frames, invalid timing values, and invalid viewport tapes', () => {
    const samples = fixture()
    samples.runs[0]!.frameMs = [10]
    expect(() => summarizeDeepzoomAbab(samples)).toThrow('one frameMs sample per tape step')

    const negative = fixture()
    negative.runs[0]!.frameMs[0] = -1
    expect(() => summarizeDeepzoomAbab(negative)).toThrow('must be nonnegative')

    const invalid = fixture()
    invalid.runs[0]!.devicePixelRatio = 0
    expect(() => summarizeDeepzoomAbab(invalid)).toThrow('devicePixelRatio must be positive')

    expect(() => normalizeViewportTape(cssTape, Number.NaN)).toThrow('must be finite')
  })
})
