import { describe, expect, test } from 'bun:test'
import {
  DEEP_ZOOM_SETTLE_MS,
  DeepZoomRefinementScheduler,
  type DeepZoomReadyTile,
  type DeepZoomRefinementClock,
} from '@pascal-app/editor/deepzoom-refinement'

class FakeClock implements DeepZoomRefinementClock {
  private time = 0
  private nextId = 0
  private jobs = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId
    this.jobs.set(id, { at: this.time + delayMs, callback })
    return id
  }

  clearTimeout(id: number): void {
    this.jobs.delete(id)
  }

  advanceTo(time: number): void {
    if (time < this.time) throw new Error('Fake clock cannot move backwards')
    while (true) {
      const next = [...this.jobs]
        .filter(([, job]) => job.at <= time)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      this.jobs.delete(next[0])
      this.time = next[1].at
      next[1].callback()
    }
    this.time = time
  }

  fireNextEarly(): void {
    const next = this.jobs.entries().next().value
    if (!next) throw new Error('No timer to fire')
    this.jobs.delete(next[0])
    next[1].callback()
  }
}

function setup() {
  const clock = new FakeClock()
  const published: Array<{ generation: number; tiles: DeepZoomReadyTile<string>[] }> = []
  const discarded: string[][] = []
  const scheduler = new DeepZoomRefinementScheduler<string>(clock, {
    publish: (generation, tiles) => {
      published.push({ generation, tiles: [...tiles] })
    },
    discard: (tiles) => {
      discarded.push(tiles.map((tile) => tile.id))
    },
  })
  const zoomIn = () => {
    const generation = scheduler.motion(2)
    if (generation === null) throw new Error('Expected active refinement')
    return generation
  }
  return { clock, published, discarded, scheduler, zoomIn }
}

describe('DeepZoom refinement scheduler', () => {
  test('t=0 and t=100 motion does not refine until t=380', () => {
    const { clock, published, discarded, scheduler, zoomIn } = setup()
    const old = zoomIn()
    expect(scheduler.stage(old, 'old', 'old pixels')).toBe(true)
    clock.advanceTo(100)
    const current = zoomIn()
    expect(scheduler.stage(current, 'current', 'current pixels')).toBe(true)
    expect(discarded).toEqual([['old']])
    clock.advanceTo(379)
    expect(published).toEqual([])
    expect(scheduler.isSettled).toBe(false)
    clock.advanceTo(380)
    expect(published).toEqual([
      { generation: current, tiles: [{ id: 'current', value: 'current pixels' }] },
    ])
    expect(scheduler.isSettled).toBe(true)
    clock.advanceTo(1000)
    expect(published).toHaveLength(1)
    expect(DEEP_ZOOM_SETTLE_MS).toBe(280)
  })

  test('zoom to 1x or below cancels the pending generation', () => {
    const { clock, published, discarded, scheduler, zoomIn } = setup()
    const generation = zoomIn()
    scheduler.stage(generation, 'tile', 'pixels')
    clock.advanceTo(100)
    expect(scheduler.motion(1)).toBeNull()
    expect(scheduler.generation).toBeNull()
    expect(scheduler.motion(0.5)).toBeNull()
    expect(scheduler.stage(generation, 'late', 'pixels')).toBe(false)
    clock.advanceTo(1000)
    expect(published).toEqual([])
    expect(discarded).toEqual([['tile']])
  })

  test('dispose clears the timer, releases staged work, and rejects later work', () => {
    const { clock, published, discarded, scheduler, zoomIn } = setup()
    const generation = zoomIn()
    scheduler.stage(generation, 'tile', 'pixels')
    clock.advanceTo(40)
    scheduler.dispose()
    scheduler.dispose()
    expect(scheduler.generation).toBeNull()
    expect(scheduler.motion(3)).toBeNull()
    expect(scheduler.stage(generation, 'late', 'pixels')).toBe(false)
    clock.advanceTo(1000)
    expect(published).toEqual([])
    expect(discarded).toEqual([['tile']])
  })

  test('late results from an older generation cannot publish', () => {
    const { clock, published, discarded, scheduler, zoomIn } = setup()
    const stale = zoomIn()
    scheduler.stage(stale, 'old', 'old pixels')
    clock.advanceTo(100)
    const latest = zoomIn()
    expect(scheduler.stage(stale, 'late', 'stale pixels')).toBe(false)
    expect(scheduler.stage(latest, 'new', 'new pixels')).toBe(true)
    clock.advanceTo(380)
    expect(published).toEqual([
      { generation: latest, tiles: [{ id: 'new', value: 'new pixels' }] },
    ])
    expect(discarded).toEqual([['old']])
  })

  test('every ready tile in a generation is released in one atomic batch', () => {
    const { clock, published, scheduler, zoomIn } = setup()
    const generation = zoomIn()
    expect(scheduler.stage(generation, '2/0_1', 'bottom')).toBe(true)
    expect(scheduler.stage(generation, '2/0_0', 'top')).toBe(true)
    expect(scheduler.stage(generation, '2/0_0', 'duplicate')).toBe(false)
    clock.advanceTo(279)
    expect(published).toEqual([])
    clock.advanceTo(280)
    expect(published).toEqual([
      {
        generation,
        tiles: [
          { id: '2/0_1', value: 'bottom' },
          { id: '2/0_0', value: 'top' },
        ],
      },
    ])
    expect(scheduler.stage(generation, '2/1_0', 'too late')).toBe(false)
    clock.advanceTo(1000)
    expect(published).toHaveLength(1)
  })

  test('an early clock callback cannot beat the settle deadline', () => {
    const { clock, published, scheduler, zoomIn } = setup()
    const generation = zoomIn()
    scheduler.stage(generation, 'tile', 'pixels')
    clock.fireNextEarly()
    clock.advanceTo(279)
    expect(published).toEqual([])
    clock.advanceTo(280)
    expect(published).toEqual([
      { generation, tiles: [{ id: 'tile', value: 'pixels' }] },
    ])
  })
})
