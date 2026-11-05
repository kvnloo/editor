import { normalizeViewportTape, summarizeDeepzoomAbab } from './deepzoom-abab.mjs'

const ARMS = ['A', 'B', 'A', 'B']
const CACHES = ['cold', 'warm']
const READY_POLL_MS = 50

/**
 * The browser harness must expose window.__deepzoomAbab with:
 * - sourceUrl: the exact signed DZI descriptor URL,
 * - viewer: an OpenSeadragon-compatible instance with world, drawer and event handlers,
 * - applyViewportStep({ zoom, panX, panY }): apply canonical CSS-pixel commands.
 *
 * OpenSeadragon 5.0.1 emits viewer "tile-loaded" and TiledImage
 * "fully-loaded-change"; viewer-wide "fully-loaded-change" is a later API.
 * A tile merely loaded into memory is not proof of a sharp frame.
 *
 * This function is passed to page.evaluate and must be self-contained.
 */
function preparePage({ sourceUrl, finalStepIndex }) {
  const bridge = window.__deepzoomAbab
  if (!bridge || !bridge.viewer?.world || typeof bridge.applyViewportStep !== 'function') {
    return null
  }
  if (bridge.sourceUrl !== sourceUrl) {
    throw new Error('Viewer harness has a different DZI URL')
  }

  const { viewer } = bridge
  const { world } = viewer
  if (world.getItemCount() === 0) return null
  const images = Array.from({ length: world.getItemCount() }, (_, index) => world.getItemAt(index))
  if (
    typeof viewer.addHandler !== 'function' ||
    typeof viewer.removeHandler !== 'function' ||
    images.some(
      (image) =>
        typeof image.addHandler !== 'function' ||
        typeof image.removeHandler !== 'function' ||
        typeof image.getFullyLoaded !== 'function',
    )
  ) {
    throw new TypeError('Viewer harness must expose OpenSeadragon tile and load events')
  }

  const dpr = window.devicePixelRatio
  if (typeof dpr !== 'number' || !Number.isFinite(dpr) || dpr <= 0) {
    throw new TypeError('Browser devicePixelRatio must be positive and finite')
  }

  const state = {
    bridge,
    viewer,
    images,
    initialDrawerType: viewer.drawer?.getType?.() ?? null,
    finalStepIndex,
    nextIndex: 0,
    firstAppliedAt: null,
    finalAppliedAt: null,
    tileAt: null,
    fullAt: null,
    sharpAt: null,
    removeHandlers: null,
  }
  const checkSharp = () => {
    if (state.sharpAt !== null || state.tileAt === null || state.fullAt === null) return
    if (images.every((image) => image.getFullyLoaded() === true)) {
      state.sharpAt = Math.max(state.tileAt, state.fullAt)
    }
  }
  const onTile = () => {
    if (state.finalAppliedAt === null) return
    state.tileAt = window.performance.now()
    checkSharp()
  }
  const onFullyLoaded = (event) => {
    if (state.finalAppliedAt === null) return
    if (event.fullyLoaded === false) {
      state.fullAt = null
      state.sharpAt = null
      return
    }
    if (event.fullyLoaded === true) {
      state.fullAt = window.performance.now()
      checkSharp()
    }
  }
  viewer.addHandler('tile-loaded', onTile)
  for (const image of images) image.addHandler('fully-loaded-change', onFullyLoaded)
  state.removeHandlers = () => {
    viewer.removeHandler('tile-loaded', onTile)
    for (const image of images) image.removeHandler('fully-loaded-change', onFullyLoaded)
  }

  window.__deepzoomAbabCollector = state
  return { devicePixelRatio: dpr }
}

function readPageNow() {
  return window.performance.now()
}

function applyStep({ index, step }) {
  const state = window.__deepzoomAbabCollector
  if (!state || index !== state.nextIndex) throw new Error('ABAB step order is invalid')
  state.nextIndex += 1

  const now = window.performance.now()
  if (index === 0) state.firstAppliedAt = now
  if (index === state.finalStepIndex) {
    state.finalAppliedAt = now
    state.tileAt = null
    state.fullAt = null
    state.sharpAt = null
  }

  state.bridge.applyViewportStep(step)

  // One frame-time sample per tape command, measured by actual rAF timestamps.
  return new Promise((resolve) => {
    window.requestAnimationFrame((before) => {
      window.requestAnimationFrame((after) => {
        resolve({ frameMs: after - before, firstAppliedAt: state.firstAppliedAt })
      })
    })
  })
}

function finishPage() {
  const state = window.__deepzoomAbabCollector
  if (!state) throw new Error('ABAB viewer observation was not installed')

  const observedDrawerType = state.viewer.drawer?.getType?.()
  const drawerType = observedDrawerType === state.initialDrawerType ? observedDrawerType : null
  const backend =
    drawerType === 'canvas'
      ? 'canvas2d'
      : ['webgl', 'webgpu', 'html', 'canvas2d'].includes(drawerType)
        ? drawerType
        : null
  const receipt = backend ? { backend, capturedAt: new Date().toISOString() } : null
  const timeToSharpMs =
    state.sharpAt === null || state.finalAppliedAt === null
      ? null
      : Math.max(0, state.sharpAt - state.finalAppliedAt)
  state.removeHandlers()
  delete window.__deepzoomAbabCollector
  return { backendReceipt: receipt, timeToSharpMs }
}

function disposePage() {
  const state = window.__deepzoomAbabCollector
  if (state) {
    state.removeHandlers()
    delete window.__deepzoomAbabCollector
  }
}

/**
 * Collect the exact eight-run input consumed by summarizeDeepzoomAbab.
 *
 * The injected page supports goto(url), evaluate(browserFunction, argument)
 * and waitFor(milliseconds). The two URLs are viewer harness pages, NOT DZI
 * descriptors. Both harnesses must load the unchanged sourceUrl.
 *
 * tape uses the contract's physical-pixel fields at reference DPR=1.
 * Browser commands use the corresponding normalized CSS-pixel values.
 * cache is an intended cold/warm slot label, NOT a verified cache purge:
 * the pure report continues to say "declared-not-verified".
 *
 * @param {{
 *   page: { goto: Function, evaluate: Function, waitFor: Function },
 *   sourceUrl: string,
 *   tape: { atMs: number, zoomPx: number, panXPx: number, panYPx: number }[],
 *   viewerUrls: { A: string, B: string },
 *   timingOrigin?: 'browser' | 'simulated',
 *   sharpTimeoutMs?: number,
 *   readyTimeoutMs?: number
 * }} options
 */
export async function collectDeepzoomAbab({
  page,
  sourceUrl,
  tape,
  viewerUrls,
  timingOrigin = 'browser',
  sharpTimeoutMs = 750,
  readyTimeoutMs = 2500,
}) {
  if (
    !page ||
    typeof page.goto !== 'function' ||
    typeof page.evaluate !== 'function' ||
    typeof page.waitFor !== 'function'
  ) {
    throw new TypeError('page must implement goto, evaluate and waitFor')
  }
  if (timingOrigin !== 'browser' && timingOrigin !== 'simulated') {
    throw new TypeError('timingOrigin must be browser or simulated')
  }
  if (
    !Number.isFinite(sharpTimeoutMs) ||
    sharpTimeoutMs < 0 ||
    !Number.isFinite(readyTimeoutMs) ||
    readyTimeoutMs < 0
  ) {
    throw new TypeError('timeouts must be nonnegative and finite')
  }
  let parsedUrl
  try {
    parsedUrl = new URL(sourceUrl)
  } catch {
    throw new TypeError('sourceUrl must be an absolute HTTP(S) DZI URL')
  }
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    !parsedUrl.pathname.toLowerCase().endsWith('.dzi')
  ) {
    throw new TypeError('sourceUrl must be an absolute HTTP(S) DZI URL')
  }
  if (
    !viewerUrls ||
    !['A', 'B'].every((arm) => typeof viewerUrls[arm] === 'string' && viewerUrls[arm])
  ) {
    throw new TypeError('viewerUrls must provide A and B harness pages')
  }

  const normalizedTape = normalizeViewportTape(tape, 1)
  const runs = []
  for (const cache of CACHES) {
    for (const arm of ARMS) {
      await page.goto(viewerUrls[arm])

      let observation = null
      const attempts = Math.ceil(readyTimeoutMs / READY_POLL_MS)
      for (let attempt = 0; attempt <= attempts; attempt++) {
        observation = await page.evaluate(preparePage, {
          sourceUrl,
          finalStepIndex: normalizedTape.length - 1,
        })
        if (observation) break
        if (attempt < attempts) await page.waitFor(READY_POLL_MS)
      }
      if (!observation) throw new Error('DeepZoom viewer harness did not become ready')

      try {
        const dpr = observation.devicePixelRatio
        const slotTape = tape.map((step) => ({
          atMs: step.atMs,
          zoomPx: step.zoomPx * dpr,
          panXPx: step.panXPx * dpr,
          panYPx: step.panYPx * dpr,
        }))
        const frameMs = []
        let firstAppliedAt = null

        for (const [index, step] of normalizedTape.entries()) {
          if (index > 0) {
            const now = await page.evaluate(readPageNow)
            await page.waitFor(Math.max(0, step.atMs - (now - firstAppliedAt)))
          }
          const captured = await page.evaluate(applyStep, {
            index,
            step: { zoom: step.zoom, panX: step.panX, panY: step.panY },
          })
          if (index === 0) firstAppliedAt = captured.firstAppliedAt
          frameMs.push(captured.frameMs)
        }

        await page.waitFor(sharpTimeoutMs)
        const { backendReceipt, timeToSharpMs } = await page.evaluate(finishPage)
        runs.push({
          arm,
          cache,
          sourceUrl,
          devicePixelRatio: dpr,
          tape: slotTape,
          frameMs,
          timeToSharpMs,
          timingOrigin,
          backendReceipt,
        })
      } finally {
        await page.evaluate(disposePage)
      }
    }
  }

  const input = { schemaVersion: 1, sourceUrl, runs }
  summarizeDeepzoomAbab(input)
  return input
}
