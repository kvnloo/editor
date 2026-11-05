export const DEEP_ZOOM_SETTLE_MS = 280

export interface DeepZoomRefinementClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): number
  clearTimeout(handle: number): void
}

export interface DeepZoomReadyTile<T> {
  id: string
  value: T
}

interface DeepZoomRefinementCallbacks<T> {
  publish(generation: number, tiles: readonly DeepZoomReadyTile<T>[]): void
  discard(tiles: readonly DeepZoomReadyTile<T>[]): void
}

export class DeepZoomRefinementScheduler<T> {
  private sequence = 0
  private active: number | null = null
  private timer: number | null = null
  private lastMotionAt = 0
  private settled = false
  private disposed = false
  private pending = new Map<string, T>()

  constructor(
    private readonly clock: DeepZoomRefinementClock,
    private readonly callbacks: DeepZoomRefinementCallbacks<T>,
  ) {}

  get generation(): number | null {
    return this.active
  }

  get isSettled(): boolean {
    return this.active !== null && this.settled
  }

  motion(zoomRatio: number): number | null {
    if (this.disposed) return null

    this.cancelTimer()
    this.discardPending()
    this.sequence += 1
    this.settled = false
    this.active = Number.isFinite(zoomRatio) && zoomRatio > 1 ? this.sequence : null

    if (this.active !== null) {
      this.lastMotionAt = this.clock.now()
      this.schedule(this.active, DEEP_ZOOM_SETTLE_MS)
    }
    return this.active
  }

  stage(generation: number, id: string, value: T): boolean {
    if (
      this.disposed ||
      this.active !== generation ||
      this.settled ||
      id.length === 0 ||
      this.pending.has(id)
    ) {
      return false
    }
    this.pending.set(id, value)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelTimer()
    this.discardPending()
    this.active = null
  }

  private schedule(generation: number, delayMs: number): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      if (this.disposed || this.active !== generation) return

      const remaining = this.lastMotionAt + DEEP_ZOOM_SETTLE_MS - this.clock.now()
      if (remaining > 0) {
        this.schedule(generation, remaining)
        return
      }

      this.settled = true
      this.callbacks.publish(generation, this.drainPending())
    }, delayMs)
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private drainPending(): DeepZoomReadyTile<T>[] {
    const tiles = Array.from(this.pending, ([id, value]) => ({ id, value }))
    this.pending.clear()
    return tiles
  }

  private discardPending(): void {
    if (this.pending.size !== 0) this.callbacks.discard(this.drainPending())
  }
}
