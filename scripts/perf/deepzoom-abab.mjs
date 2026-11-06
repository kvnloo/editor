// @ts-check
import { readFile } from 'node:fs/promises'

const ARM_ORDER = ['A', 'B', 'A', 'B']
const CACHE_ORDER = ['cold', 'warm']
const BACKENDS = new Set(['webgl', 'webgpu', 'canvas2d', 'html'])

/**
 * All zoom and pan coordinates in the input tape are physical device pixels.
 * Dividing by DPR gives a common CSS-pixel tape for both implementations.
 *
 * @typedef {{ atMs: number, zoomPx: number, panXPx: number, panYPx: number }} ViewportStep
 * @typedef {{ backend: 'webgl' | 'webgpu' | 'canvas2d' | 'html', capturedAt: string }} BackendReceipt
 * @typedef {{
 *   arm: 'A' | 'B',
 *   cache: 'cold' | 'warm',
 *   sourceUrl: string,
 *   devicePixelRatio: number,
 *   tape: ViewportStep[],
 *   frameMs: number[],
 *   timeToSharpMs: number | null,
 *   timingOrigin: 'browser' | 'simulated',
 *   backendReceipt?: BackendReceipt | null
 * }} AbabRun
 * @typedef {{ schemaVersion: 1, sourceUrl: string, runs: AbabRun[] }} AbabInput
 */

/** @param {unknown} condition @param {string} message */
function requireValue(condition, message) {
  if (!condition) throw new TypeError(message)
}

/** @param {unknown} value @param {string} name @returns {number} */
function finite(value, name) {
  requireValue(typeof value === 'number' && Number.isFinite(value), name + ' must be finite')
  return /** @type {number} */ (value)
}

/** @param {unknown} value @param {string} name @returns {number} */
function nonnegative(value, name) {
  const result = finite(value, name)
  requireValue(result >= 0, name + ' must be nonnegative')
  return result
}

/** @param {unknown} value @param {string} name @returns {number} */
function positive(value, name) {
  const result = finite(value, name)
  requireValue(result > 0, name + ' must be positive')
  return result
}

/**
 * Nearest-rank percentile (sorted index ceil(p/100 * n) - 1).
 * No interpolation, averaging, or dropped samples.
 *
 * @param {number[]} samples
 * @param {number} percentile
 */
export function nearestRankPercentile(samples, percentile) {
  requireValue(Array.isArray(samples) && samples.length > 0, 'samples must be nonempty')
  requireValue(
    Number.isFinite(percentile) && percentile > 0 && percentile <= 100,
    'percentile must be in (0, 100]',
  )
  for (const sample of samples) nonnegative(sample, 'sample')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1]
}

/**
 * Normalize physical-pixel zoom/pan commands to CSS pixels at DPR=1.
 * Commands carry exact relative times so the replay pacing is also identical.
 *
 * @param {ViewportStep[]} tape
 * @param {number} devicePixelRatio
 */
export function normalizeViewportTape(tape, devicePixelRatio) {
  const dpr = positive(devicePixelRatio, 'devicePixelRatio')
  requireValue(Array.isArray(tape) && tape.length > 0, 'tape must be nonempty')
  let previousAtMs = -1

  return tape.map((step, index) => {
    requireValue(step && typeof step === 'object', 'tape step must be an object')
    const atMs = nonnegative(step.atMs, 'tape atMs')
    requireValue(
      index === 0 ? atMs === 0 : atMs > previousAtMs,
      'tape must start at 0ms and have increasing timestamps',
    )
    previousAtMs = atMs
    const zoomPx = positive(step.zoomPx, 'tape zoomPx')
    const panXPx = finite(step.panXPx, 'tape panXPx')
    const panYPx = finite(step.panYPx, 'tape panYPx')
    const normalize = (/** @type {number} */ pixels) => Number((pixels / dpr).toFixed(9))
    return {
      atMs,
      zoom: normalize(zoomPx),
      panX: normalize(panXPx),
      panY: normalize(panYPx),
    }
  })
}

/** @param {string} sourceUrl */
function validateSourceUrl(sourceUrl) {
  requireValue(typeof sourceUrl === 'string', 'source URL must be a string')
  let parsed
  try {
    parsed = new URL(sourceUrl)
  } catch {
    throw new TypeError('source URL must be absolute')
  }
  requireValue(
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.pathname.toLowerCase().endsWith('.dzi'),
    'source URL must be an HTTP(S) DZI descriptor',
  )
  return sourceUrl
}

/** @param {BackendReceipt | null | undefined} receipt @param {number} index */
function readBackend(receipt, index) {
  if (receipt == null) return null
  requireValue(
    typeof receipt === 'object' && BACKENDS.has(receipt.backend),
    'run ' + index + ' has an invalid backend receipt',
  )
  requireValue(
    typeof receipt.capturedAt === 'string' && Number.isFinite(Date.parse(receipt.capturedAt)),
    'run ' + index + ' backend receipt needs an ISO timestamp',
  )
  return receipt.backend
}

/**
 * Pure receipt calculation. Input must contain eight runs: cold ABAB, then warm
 * ABAB. Each frameMs sample corresponds to one command in the same timed tape.
 * The caller, not this script, clears/seeds caches and records browser timings.
 * A backend name is self-reported; this utility cannot produce real GPU proof.
 *
 * @param {AbabInput} input
 */
export function summarizeDeepzoomAbab(input) {
  requireValue(input && typeof input === 'object', 'input must be an object')
  requireValue(input.schemaVersion === 1, 'unsupported ABAB schema version')
  const sourceUrl = validateSourceUrl(input.sourceUrl)
  requireValue(
    Array.isArray(input.runs) && input.runs.length === 8,
    'runs must contain cold ABAB followed by warm ABAB (eight runs)',
  )
  requireValue(input.runs[0] && typeof input.runs[0] === 'object', 'run 0 must be an object')
  const tape = normalizeViewportTape(input.runs[0].tape, input.runs[0].devicePixelRatio)

  const runs = []
  for (let index = 0; index < input.runs.length; index++) {
    const run = input.runs[index]
    requireValue(run && typeof run === 'object', 'run ' + index + ' must be an object')
    const cache = CACHE_ORDER[Math.floor(index / 4)]
    const arm = ARM_ORDER[index % 4]
    requireValue(
      run.cache === cache && run.arm === arm,
      'run ' + index + ' must be ' + cache + ' ' + arm + ' in ABAB order',
    )
    requireValue(run.sourceUrl === sourceUrl, 'run ' + index + ' has a different source URL')
    const normalizedTape = normalizeViewportTape(run.tape, run.devicePixelRatio)
    requireValue(
      JSON.stringify(normalizedTape) === JSON.stringify(tape),
      'run ' + index + ' has a different zoom/pan tape',
    )
    requireValue(
      Array.isArray(run.frameMs) && run.frameMs.length === tape.length,
      'run ' + index + ' must provide one frameMs sample per tape step',
    )
    for (const ms of run.frameMs) nonnegative(ms, 'run ' + index + ' frameMs')
    if (run.timeToSharpMs !== null) {
      nonnegative(run.timeToSharpMs, 'run ' + index + ' timeToSharpMs')
    }
    requireValue(
      run.timingOrigin === 'browser' || run.timingOrigin === 'simulated',
      'run ' + index + ' timingOrigin must be browser or simulated',
    )
    runs.push({
      arm: run.arm,
      cache: run.cache,
      devicePixelRatio: run.devicePixelRatio,
      frameMs: run.frameMs,
      timeToSharpMs: run.timeToSharpMs,
      timingOrigin: run.timingOrigin,
      backend: readBackend(run.backendReceipt, index),
    })
  }

  const results = CACHE_ORDER.flatMap((cache) =>
    ['A', 'B'].map((arm) => {
      const selected = runs.filter((run) => run.cache === cache && run.arm === arm)
      const frameMs = selected.flatMap((run) => run.frameMs)
      const sharpKnown = selected.every((run) => run.timeToSharpMs !== null)
      const sharpMs = selected.map((run) => run.timeToSharpMs)
      const simulated = selected.some((run) => run.timingOrigin === 'simulated')
      const hasBackend = selected.every((run) => run.backend !== null)
      const stableBackend = hasBackend && new Set(selected.map((run) => run.backend)).size === 1

      return {
        cache,
        arm,
        runCount: selected.length,
        frameCount: frameMs.length,
        devicePixelRatios: selected.map((run) => run.devicePixelRatio),
        backend: !simulated && stableBackend ? selected[0].backend : 'unknown',
        timingEvidence: simulated
          ? 'simulated'
          : stableBackend
            ? 'browser-reported'
            : 'unknown',
        gpuEvidence: 'unknown',
        frameMs: {
          p50: nearestRankPercentile(frameMs, 50),
          p95: nearestRankPercentile(frameMs, 95),
        },
        timeToSharpMs: sharpKnown
          ? {
              p50: nearestRankPercentile(/** @type {number[]} */ (sharpMs), 50),
              p95: nearestRankPercentile(/** @type {number[]} */ (sharpMs), 95),
            }
          : { p50: null, p95: null },
      }
    }),
  )

  return {
    schemaVersion: 1,
    sourceUrl,
    normalizedDpr: 1,
    tape,
    cacheEvidence: 'declared-not-verified',
    gpuEvidence: 'unknown',
    results,
  }
}

if (import.meta.main) {
  const inputPath = process.argv[2]
  if (!inputPath || process.argv.length !== 3) {
    console.error('Usage: bun scripts/perf/deepzoom-abab.mjs <input.json>')
    process.exitCode = 2
  } else {
    try {
      const input = JSON.parse(await readFile(inputPath, 'utf8'))
      console.log(JSON.stringify(summarizeDeepzoomAbab(input), null, 2))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
