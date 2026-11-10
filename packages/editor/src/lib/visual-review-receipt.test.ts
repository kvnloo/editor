import { describe, expect, test } from 'bun:test'
import {
  compareVisualReviewCaptures,
  type VisualReviewCameraPose,
  type VisualReviewCapture,
} from '@pascal-app/editor'

const POSE: VisualReviewCameraPose = {
  position: [0, 0, 5],
  quaternion: [0, 0, 0, 1],
  fov: 60,
}

function capture(overrides: Partial<VisualReviewCapture> = {}): VisualReviewCapture {
  return {
    width: 2,
    height: 2,
    rgba: new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ]),
    cameraPose: POSE,
    ...overrides,
  }
}

describe('compareVisualReviewCaptures', () => {
  test('passes matched 2x2 RGBA captures with zero mismatched pixels', () => {
    const receipt = compareVisualReviewCaptures(capture(), capture())

    expect(receipt.status).toBe('pass')
    expect(receipt.mismatchRatio).toBe(0)
    expect(receipt.sourceHash).toBe(receipt.bakedHash)
    expect(receipt.sourceHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  test('counts one changed pixel as one quarter, even if only one channel changes', () => {
    const baked = capture()
    baked.rgba[12] = 101

    const receipt = compareVisualReviewCaptures(capture(), baked)

    expect(receipt.status).toBe('fail')
    expect(receipt.mismatchRatio).toBe(0.25)
    expect(receipt.sourceHash).not.toBe(receipt.bakedHash)
  })

  test('counts a different alpha byte as a changed pixel', () => {
    const baked = capture()
    baked.rgba[3] = 128

    const receipt = compareVisualReviewCaptures(capture(), baked)

    expect(receipt.status).toBe('fail')
    expect(receipt.mismatchRatio).toBe(0.25)
  })

  test('marks missing captures unknown, preserving available capture fingerprints', () => {
    const missingSource = compareVisualReviewCaptures(undefined, capture())
    expect(missingSource.status).toBe('unknown')
    expect(missingSource.mismatchRatio).toBeNull()
    expect(missingSource.sourceHash).toBeNull()
    expect(missingSource.bakedHash).not.toBeNull()

    const missingBoth = compareVisualReviewCaptures(null, null)
    expect(missingBoth).toEqual({
      status: 'unknown',
      mismatchRatio: null,
      sourceHash: null,
      bakedHash: null,
    })
  })

  test('never passes unchanged pixels captured from a different camera position or lens', () => {
    const moved = capture({
      cameraPose: { ...POSE, position: [0.0001, 0, 5] },
    })
    const differentFov = capture({
      cameraPose: { ...POSE, fov: 61 },
    })

    for (const baked of [moved, differentFov]) {
      const receipt = compareVisualReviewCaptures(capture(), baked)
      expect(receipt.status).toBe('unknown')
      expect(receipt.mismatchRatio).toBeNull()
      expect(receipt.sourceHash).toBe(receipt.bakedHash)
    }
  })

  test('accepts pose differences within epsilon and equivalent quaternion signs', () => {
    const near = capture({
      cameraPose: { ...POSE, position: [0.000005, 0, 5], quaternion: [0, 0, 0, -1] },
    })

    const receipt = compareVisualReviewCaptures(capture(), near)

    expect(receipt.status).toBe('pass')
    expect(receipt.mismatchRatio).toBe(0)
  })

  test('rejects a quaternion rotation beyond epsilon and an invalid quaternion', () => {
    const rotated = capture({
      cameraPose: {
        ...POSE,
        quaternion: [0, 0.01, 0, Math.sqrt(1 - 0.01 ** 2)],
      },
    })
    const invalid = capture({
      cameraPose: { ...POSE, quaternion: [0, 0, 0, 0] },
    })

    expect(compareVisualReviewCaptures(capture(), rotated).status).toBe('unknown')
    expect(compareVisualReviewCaptures(capture(), invalid).status).toBe('unknown')
  })

  test('rejects unequal dimensions even when all RGBA bytes match', () => {
    const baked = capture({ width: 1, height: 4 })

    const receipt = compareVisualReviewCaptures(capture(), baked)

    expect(receipt.status).toBe('unknown')
    expect(receipt.mismatchRatio).toBeNull()
    expect(receipt.sourceHash).not.toBe(receipt.bakedHash)
  })

  test('rejects incomplete RGBA data instead of silently comparing truncated pixels', () => {
    const baked = capture({ rgba: new Uint8Array(15) })

    const receipt = compareVisualReviewCaptures(capture(), baked)

    expect(receipt.status).toBe('unknown')
    expect(receipt.mismatchRatio).toBeNull()
    expect(receipt.sourceHash).not.toBeNull()
    expect(receipt.bakedHash).toBeNull()
  })

  test('rejects invalid pose epsilon and missing camera receipt', () => {
    expect(compareVisualReviewCaptures(capture(), capture(), Number.NaN).status).toBe('unknown')
    expect(compareVisualReviewCaptures(capture(), capture({ cameraPose: null })).status).toBe(
      'unknown',
    )
  })
})
