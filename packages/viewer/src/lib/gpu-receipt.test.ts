// @ts-expect-error — bun:test types are provided by the runner, not viewer's declaration build.
import { describe, expect, mock, test } from 'bun:test'
import {
  gpuReceipt,
  initializeGpuRenderer,
  type GpuReceiptSample,
} from '../index'

const webgpuInitialization = {
  backend: 'webgpu',
  renderer: {},
  status: 'ready',
} as const

const fourFrames: GpuReceiptSample[] = [10, 20, 30, 40].map((cpuMs) => ({
  cpuMs,
  gpuRenderMs: 5,
}))

describe('gpuReceipt', () => {
  test('uses nearest-rank p50 and p95 for actual per-frame durations', () => {
    const receipt = gpuReceipt([fourFrames[3], fourFrames[0], fourFrames[2], fourFrames[1]], {
      initialization: webgpuInitialization,
      budgetMs: 50,
    })

    expect(receipt).toEqual({
      backend: 'webgpu',
      frames: 4,
      cpu: { p50: 20, p95: 40, max: 40 },
      gpu: { p50: 5, p95: 5 },
      budgetMs: 50,
      pass: true,
    })
    expect(fourFrames.map((frame) => frame.cpuMs)).toEqual([10, 20, 30, 40])
  })

  test('fails the 16.7ms budget on CPU p95 rather than median', () => {
    const receipt = gpuReceipt(fourFrames, {
      initialization: webgpuInitialization,
      budgetMs: 16.7,
    })
    expect(receipt.cpu).toEqual({ p50: 20, p95: 40, max: 40 })
    expect(receipt.pass).toBe(false)
  })

  test('also fails when GPU p95 exceeds the budget', () => {
    const receipt = gpuReceipt(
      [
        { cpuMs: 5, gpuRenderMs: 3 },
        { cpuMs: 6, gpuRenderMs: 4 },
        { cpuMs: 7, gpuRenderMs: 8 },
        { cpuMs: 8, gpuRenderMs: 20 },
      ],
      { initialization: webgpuInitialization, budgetMs: 16.7 },
    )
    expect(receipt.gpu).toEqual({ p50: 4, p95: 20 })
    expect(receipt.pass).toBe(false)
  })

  test('reports initialized WebGL rather than a WebGPU wrapper claim', async () => {
    const requestAdapter = mock(async () => {
      throw new Error('WebGPU adapter should not be requested')
    })
    const initialized = await initializeGpuRenderer({
      createRenderer: () => ({ backend: 'webgpu' as const, init: async () => undefined }),
      forceWebGL: true,
      gpu: { requestAdapter },
      probeCanvas: { getContext: () => ({}) },
    })
    expect(initialized.status).toBe('ready')
    const receipt = gpuReceipt([{ cpuMs: 8, gpuRenderMs: 4 }], {
      initialization: initialized,
      budgetMs: 16.7,
    })
    expect(receipt.backend).toBe('webgl')
    expect(requestAdapter).not.toHaveBeenCalled()
  })

  test('preserves unavailable or partially missing GPU timestamps as null', () => {
    const missing = gpuReceipt([{ cpuMs: 6 }, { cpuMs: 8, gpuRenderMs: null }], {
      initialization: webgpuInitialization,
      budgetMs: 16.7,
    })
    const partial = gpuReceipt(
      [{ cpuMs: 6, gpuRenderMs: 3 }, { cpuMs: 8, gpuRenderMs: null }],
      { initialization: webgpuInitialization, budgetMs: 16.7 },
    )
    expect(missing.gpu).toBeNull()
    expect(partial.gpu).toBeNull()
    expect(missing.pass).toBe(false)
    expect(partial.pass).toBe(false)
    expect(partial.cpu).toEqual({ p50: 6, p95: 8, max: 8 })
  })

  test('refuses empty, invalid and unsupported receipts', () => {
    expect(() => gpuReceipt([], { initialization: webgpuInitialization, budgetMs: 16.7 })).toThrow()
    expect(() =>
      gpuReceipt([{ cpuMs: Number.NaN, gpuRenderMs: 4 }], {
        initialization: webgpuInitialization,
        budgetMs: 16.7,
      }),
    ).toThrow()
    expect(() =>
      gpuReceipt([{ cpuMs: 5, gpuRenderMs: -1 }], {
        initialization: webgpuInitialization,
        budgetMs: 16.7,
      }),
    ).toThrow()
    expect(() =>
      gpuReceipt([{ cpuMs: 5, gpuRenderMs: 2 }], {
        initialization: webgpuInitialization,
        budgetMs: 0,
      }),
    ).toThrow()
    expect(() =>
      gpuReceipt([{ cpuMs: 5, gpuRenderMs: 2 }], {
        initialization: { status: 'unsupported' },
        budgetMs: 16.7,
      }),
    ).toThrow()
  })
})
