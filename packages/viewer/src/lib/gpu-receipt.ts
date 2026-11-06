import type { RendererInitializationResult } from './renderer-capability'

/**
 * Per-frame samples from the frame-cpu and gpu-render performance tracks.
 * gpuRenderMs is a device timestamp duration, never gpu-queue or render-encode
 * CPU wall time. Aggregate PerfCounterBuckets cannot supply percentiles.
 */
export type GpuReceiptSample = {
  cpuMs: number
  gpuRenderMs?: number | null
}

export type GpuReceiptMeta = {
  budgetMs: number
  initialization: RendererInitializationResult<unknown>
}

type ReceiptPercentiles = {
  p50: number
  p95: number
}

type ReadyBackend = Extract<RendererInitializationResult<unknown>, { status: 'ready' }>['backend']

export type GpuReceipt = {
  backend: ReadyBackend
  frames: number
  cpu: ReceiptPercentiles & { max: number }
  gpu: ReceiptPercentiles | null
  budgetMs: number
  pass: boolean
}

function nearestRank(sorted: readonly number[], quantile: number): number {
  const value = sorted[Math.ceil(quantile * sorted.length) - 1]
  if (value === undefined) throw new RangeError('GPU receipt needs at least one frame')
  return value
}

function assertDuration(ms: number, label: string): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(label + ' must be a finite, non-negative duration')
  }
}

/** Summarize correlated frames; this does not capture or prove a hardware run. */
export function gpuReceipt(samples: readonly GpuReceiptSample[], meta: GpuReceiptMeta): GpuReceipt {
  if (meta.initialization.status !== 'ready') {
    throw new Error('GPU receipt needs a ready renderer initialization')
  }
  if (!Number.isFinite(meta.budgetMs) || meta.budgetMs <= 0) {
    throw new RangeError('GPU receipt budget must be finite and positive')
  }
  if (samples.length === 0) throw new RangeError('GPU receipt needs at least one frame')

  const cpuMs: number[] = []
  const gpuMs: number[] = []
  for (const sample of samples) {
    assertDuration(sample.cpuMs, 'CPU frame')
    cpuMs.push(sample.cpuMs)
    if (sample.gpuRenderMs != null) {
      assertDuration(sample.gpuRenderMs, 'GPU timestamp')
      gpuMs.push(sample.gpuRenderMs)
    }
  }

  cpuMs.sort((a, b) => a - b)
  const cpu = {
    p50: nearestRank(cpuMs, 0.5),
    p95: nearestRank(cpuMs, 0.95),
    max: nearestRank(cpuMs, 1),
  }

  // Incomplete GPU timestamps must not turn the observed subset into a pass.
  const allGpuTimestamps = gpuMs.length === samples.length
  if (allGpuTimestamps) gpuMs.sort((a, b) => a - b)
  const gpu = allGpuTimestamps
    ? { p50: nearestRank(gpuMs, 0.5), p95: nearestRank(gpuMs, 0.95) }
    : null

  return {
    backend: meta.initialization.backend,
    frames: samples.length,
    cpu,
    gpu,
    budgetMs: meta.budgetMs,
    pass: gpu !== null && cpu.p95 <= meta.budgetMs && gpu.p95 <= meta.budgetMs,
  }
}
