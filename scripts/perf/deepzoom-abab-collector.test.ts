import { describe, expect, test } from 'bun:test'
import { summarizeDeepzoomAbab } from './deepzoom-abab.mjs'
import { collectDeepzoomAbab } from './deepzoom-abab-collector.mjs'

const sourceUrl = 'https://assets.example.test/campus.dzi?signature=unchanged'
const viewerUrls = {
  A: 'https://bench.example.test/viewer-a',
  B: 'https://bench.example.test/viewer-b',
}
const tape = [
  { atMs: 0, zoomPx: 1, panXPx: 10, panYPx: -2 },
  { atMs: 80, zoomPx: 2, panXPx: 30, panYPx: 6 },
]

type Handler = (event: { fullyLoaded?: boolean }) => void
type Command = { slot: number; zoom: number; panX: number; panY: number }

class FakeEvents {
  private handlers = new Map<string, Set<Handler>>()

  addHandler(name: string, handler: Handler) {
    const handlers = this.handlers.get(name) ?? new Set<Handler>()
    handlers.add(handler)
    this.handlers.set(name, handlers)
  }

  removeHandler(name: string, handler: Handler) {
    this.handlers.get(name)?.delete(handler)
  }

  raise(name: string, event: { fullyLoaded?: boolean } = {}) {
    for (const handler of this.handlers.get(name) ?? []) handler(event)
  }
}

class FakePage {
  readonly navigations: string[] = []
  readonly commands: Command[] = []
  readonly waits: number[] = []
  clockMs = 0
  private slot = -1
  private pageWindow: Record<string, unknown> = {}

  constructor(
    private readonly options: {
      missingTileSlot?: number
      missingBackendSlot?: number
      suppliedSourceUrl?: string
    } = {},
  ) {}

  async goto(url: string) {
    this.slot += 1
    this.navigations.push(url)
    const slot = this.slot
    let fullyLoaded = false
    const image = Object.assign(new FakeEvents(), {
      getFullyLoaded: () => fullyLoaded,
    })
    const viewer = Object.assign(new FakeEvents(), {
      world: {
        getItemCount: () => 1,
        getItemAt: () => image,
      },
      drawer: {
        getType: () => (slot === this.options.missingBackendSlot ? 'unobservable' : 'webgl'),
      },
    })

    this.pageWindow = {
      __deepzoomAbab: {
        sourceUrl: this.options.suppliedSourceUrl ?? sourceUrl,
        viewer,
        applyViewportStep: ({ zoom, panX, panY }: Omit<Command, 'slot'>) => {
          this.commands.push({ slot, zoom, panX, panY })
          fullyLoaded = false
          this.clockMs += 12
          if (slot !== this.options.missingTileSlot) {
            viewer.raise('tile-loaded')
            fullyLoaded = true
            image.raise('fully-loaded-change', { fullyLoaded: true })
          }
        },
      },
      devicePixelRatio: slot % 2 === 0 ? 1 : 2,
      performance: { now: () => this.clockMs },
      requestAnimationFrame: (callback: (timestamp: number) => void) => {
        this.clockMs += 16
        const timestamp = this.clockMs
        queueMicrotask(() => callback(timestamp))
        return timestamp
      },
    }
  }

  async evaluate<T>(fn: (arg: any) => T | Promise<T>, arg?: unknown): Promise<T> {
    // Run the actual serializable browser callback, not a mocked method name.
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: this.pageWindow,
    })
    try {
      return await fn(arg)
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, 'window', previous)
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
    }
  }

  async waitFor(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error('Fake clock cannot advance by a negative duration')
    }
    this.waits.push(milliseconds)
    this.clockMs += milliseconds
  }
}

const options = (page: FakePage) => ({
  page,
  sourceUrl,
  tape,
  viewerUrls,
  timingOrigin: 'simulated' as const,
  sharpTimeoutMs: 64,
})

describe('DeepZoom ABAB browser collector', () => {
  test('replays cold/warm ABAB using the exact signed DZI and normalized tape', async () => {
    const page = new FakePage()
    const input = await collectDeepzoomAbab(options(page))

    expect(page.navigations).toEqual([
      viewerUrls.A,
      viewerUrls.B,
      viewerUrls.A,
      viewerUrls.B,
      viewerUrls.A,
      viewerUrls.B,
      viewerUrls.A,
      viewerUrls.B,
    ])
    expect(input.runs.map((run) => [run.cache, run.arm])).toEqual([
      ['cold', 'A'],
      ['cold', 'B'],
      ['cold', 'A'],
      ['cold', 'B'],
      ['warm', 'A'],
      ['warm', 'B'],
      ['warm', 'A'],
      ['warm', 'B'],
    ])
    expect(input.runs.every((run) => run.sourceUrl === sourceUrl)).toBe(true)
    expect(input.runs.map((run) => run.devicePixelRatio)).toEqual([1, 2, 1, 2, 1, 2, 1, 2])
    expect(input.runs[1]?.tape).toEqual([
      { atMs: 0, zoomPx: 2, panXPx: 20, panYPx: -4 },
      { atMs: 80, zoomPx: 4, panXPx: 60, panYPx: 12 },
    ])
    expect(page.commands).toHaveLength(16)
    expect(page.commands.filter((step) => step.slot === 1)).toEqual([
      { slot: 1, zoom: 1, panX: 10, panY: -2 },
      { slot: 1, zoom: 2, panX: 30, panY: 6 },
    ])
    expect(page.waits).toContain(36)
    expect(input.runs.every((run) => run.frameMs.join(',') === '16,16')).toBe(true)
    expect(input.runs.every((run) => run.timeToSharpMs === 12)).toBe(true)
    expect(input.runs.every((run) => run.timingOrigin === 'simulated')).toBe(true)

    const report = summarizeDeepzoomAbab(input)
    expect(report.results[0]?.frameMs).toEqual({ p50: 16, p95: 16 })
    expect(report.results[0]?.timeToSharpMs).toEqual({ p50: 12, p95: 12 })
    expect(report.cacheEvidence).toBe('declared-not-verified')
    expect(report.gpuEvidence).toBe('unknown')
    expect(report.results[0]?.timingEvidence).toBe('simulated')
  })

  test('missing tile-loaded evidence leaves sharpness unknown, never zero', async () => {
    const page = new FakePage({ missingTileSlot: 2 })
    const input = await collectDeepzoomAbab(options(page))
    expect(input.runs[0]?.timeToSharpMs).toBe(12)
    expect(input.runs[2]?.timeToSharpMs).toBeNull()
    expect(summarizeDeepzoomAbab(input).results[0]?.timeToSharpMs).toEqual({
      p50: null,
      p95: null,
    })
  })

  test('unobservable backend has no receipt and the browser cannot verify the cache', async () => {
    const page = new FakePage({ missingBackendSlot: 1 })
    const input = await collectDeepzoomAbab(options(page))
    expect(input.runs[0]?.backendReceipt?.backend).toBe('webgl')
    expect(input.runs[1]?.backendReceipt).toBeNull()
    expect(summarizeDeepzoomAbab(input).results[1]?.backend).toBe('unknown')
    expect(summarizeDeepzoomAbab(input).cacheEvidence).toBe('declared-not-verified')
  })

  test('refuses a harness that actually loaded a different DZI', async () => {
    const page = new FakePage({
      suppliedSourceUrl: 'https://assets.example.test/campus.dzi?signature=other',
    })
    await expect(collectDeepzoomAbab(options(page))).rejects.toThrow('different DZI URL')
  })
})
