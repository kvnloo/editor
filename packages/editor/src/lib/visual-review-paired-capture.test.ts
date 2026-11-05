import { describe, expect, test } from 'bun:test'
import {
  captureVisualReviewPair,
  type VisualReviewFrameKind,
  type VisualReviewFrameRenderer,
} from './visual-review-paired-capture'
import { compareVisualReviewCaptures, type VisualReviewCameraPose } from './visual-review-receipt'

const POSE: VisualReviewCameraPose = {
  position: [0, 0, 5],
  quaternion: [0, 0, 0, 1],
  fov: 60,
}

type FakeOptions = {
  bakedPose?: VisualReviewCameraPose | null
  failOn?: VisualReviewFrameKind
  failDuring?: 'render' | 'read'
  changeBakedPixel?: boolean
}

function fakeRenderer(options: FakeOptions = {}) {
  const events: string[] = []
  const pixels = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
  ])
  let currentKind: VisualReviewFrameKind | null = null
  let currentPose: VisualReviewCameraPose | null = null

  const renderer: VisualReviewFrameRenderer = {
    prepareFrame(kind, requestedPose, restore) {
      const previousKind = currentKind
      const previousPose = currentPose
      restore(() => {
        events.push(`restore:${kind}`)
        currentKind = previousKind
        currentPose = previousPose
      })
      events.push(`prepare:${kind}`)
      currentKind = kind
      currentPose =
        kind === 'baked' && options.bakedPose !== undefined ? options.bakedPose : requestedPose
    },
    renderFrame(kind) {
      events.push(`render:${kind}`)
      if (options.failOn === kind && options.failDuring === 'render') {
        throw new Error('renderer failed')
      }
    },
    getCameraPose() {
      return currentPose
    },
    readPixels(width, height) {
      expect([width, height]).toEqual([2, 2])
      events.push(`read:${currentKind}`)
      if (options.failOn === currentKind && options.failDuring === 'read') {
        const kind = currentKind
        return Promise.resolve().then(() => {
          events.push(`settle:${kind}`)
          throw new Error('readPixels failed')
        })
      }
      if (currentKind === 'baked' && options.changeBakedPixel) pixels[0] = 11
      return Promise.resolve(pixels)
    },
  }

  return { renderer, events }
}

describe('captureVisualReviewPair', () => {
  test('renders both frames from one requested pose and passes identical RGBA', async () => {
    const { renderer, events } = fakeRenderer()
    const paired = await captureVisualReviewPair(renderer, POSE, { width: 2, height: 2 })
    const receipt = compareVisualReviewCaptures(paired.source, paired.baked)

    expect(paired.pose).toEqual(POSE)
    expect(paired.source?.cameraPose).toEqual(POSE)
    expect(paired.baked?.cameraPose).toEqual(POSE)
    expect(paired.source?.rgba).not.toBe(paired.baked?.rgba)
    expect(receipt.status).toBe('pass')
    expect(receipt.mismatchRatio).toBe(0)
    expect(events).toEqual([
      'prepare:source',
      'render:source',
      'read:source',
      'restore:source',
      'prepare:baked',
      'render:baked',
      'read:baked',
      'restore:baked',
    ])
  })

  test('returns unknown for camera drift even when the RGBA bytes match', async () => {
    const { renderer } = fakeRenderer({
      bakedPose: { ...POSE, position: [0.001, 0, 5] },
    })
    const paired = await captureVisualReviewPair(renderer, POSE, { width: 2, height: 2 })
    const receipt = compareVisualReviewCaptures(paired.source, paired.baked)

    expect(paired.pose).toEqual(POSE)
    expect(receipt.status).toBe('unknown')
    expect(receipt.mismatchRatio).toBeNull()
    expect(receipt.sourceHash).toBe(receipt.bakedHash)
  })

  test('restores the baked scene before an asynchronous pixel-read failure settles', async () => {
    const { renderer, events } = fakeRenderer({ failOn: 'baked', failDuring: 'read' })
    const paired = await captureVisualReviewPair(renderer, POSE, { width: 2, height: 2 })
    const receipt = compareVisualReviewCaptures(paired.source, paired.baked)

    expect(paired.source).not.toBeNull()
    expect(paired.baked).toBeNull()
    expect(receipt.status).toBe('unknown')
    expect(receipt.mismatchRatio).toBeNull()
    expect(events).toContain('restore:baked')
    expect(events.indexOf('restore:baked')).toBeGreaterThan(events.indexOf('read:baked'))
    expect(events.indexOf('restore:baked')).toBeLessThan(events.indexOf('settle:baked'))
  })

  test('restores the source scene after a synchronous renderer failure', async () => {
    const { renderer, events } = fakeRenderer({ failOn: 'source', failDuring: 'render' })
    const paired = await captureVisualReviewPair(renderer, POSE, { width: 2, height: 2 })

    expect(paired.source).toBeNull()
    expect(paired.baked).not.toBeNull()
    expect(compareVisualReviewCaptures(paired.source, paired.baked).status).toBe('unknown')
    expect(events.slice(0, 3)).toEqual(['prepare:source', 'render:source', 'restore:source'])
    expect(events).toContain('restore:baked')
  })

  test('copies reused pixel buffers so one baked pixel change remains a one-quarter mismatch', async () => {
    const { renderer } = fakeRenderer({ changeBakedPixel: true })
    const paired = await captureVisualReviewPair(renderer, POSE, { width: 2, height: 2 })
    const receipt = compareVisualReviewCaptures(paired.source, paired.baked)

    expect(paired.source?.rgba[0]).toBe(10)
    expect(paired.baked?.rgba[0]).toBe(11)
    expect(receipt.status).toBe('fail')
    expect(receipt.mismatchRatio).toBe(0.25)
  })

  test('rejects unsafe dimensions without invoking the renderer', async () => {
    const { renderer, events } = fakeRenderer()
    const paired = await captureVisualReviewPair(renderer, POSE, {
      width: Number.MAX_SAFE_INTEGER,
      height: 2,
    })

    expect(paired.source).toBeNull()
    expect(paired.baked).toBeNull()
    expect(compareVisualReviewCaptures(paired.source, paired.baked).status).toBe('unknown')
    expect(events).toEqual([])
  })
})
