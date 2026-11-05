import { describe, expect, test } from 'bun:test'
import { createFitSceneControlsCoordinator } from '@pascal-app/editor'

describe('public editor fit-scene camera lifecycle', () => {
  test('replays exactly once when the orbit ref attaches after the resume frame', () => {
    const mode = { isFirstPersonMode: true, isPreviewMode: false }
    const scheduled = new Map<number, () => void>()
    let nextFrame = 0
    const calls: [number, number, number, number, number, number, boolean][] = []

    const coordinator = createFitSceneControlsCoordinator({
      getMode: () => mode,
      requestFrame: (callback) => {
        const frame = ++nextFrame
        scheduled.set(frame, callback)
        return frame
      },
      cancelFrame: (frame) => {
        scheduled.delete(frame)
      },
    })
    const advanceFrame = () => {
      const callbacks = [...scheduled.values()]
      scheduled.clear()
      for (const callback of callbacks) callback()
    }

    coordinator.onFitScene({ center: [10, 20], size: [30, 40] })
    mode.isFirstPersonMode = false
    coordinator.onOrbitResume()
    advanceFrame()
    expect(calls).toHaveLength(0)

    coordinator.attachControls({
      setLookAt: (eyeX, eyeY, eyeZ, targetX, targetY, targetZ, animated) => {
        calls.push([eyeX, eyeY, eyeZ, targetX, targetY, targetZ, animated])
      },
    })
    advanceFrame()
    expect(calls).toHaveLength(1)
    const pose = calls[0]
    if (!pose) throw new Error('Queued fit was not applied')
    for (const [index, expected] of [49.2, 32, 59.2, 10, 0, 20].entries()) {
      expect(pose[index]).toBeCloseTo(expected, 6)
    }
    expect(pose[6]).toBe(true)

    advanceFrame()
    expect(calls).toHaveLength(1)
    coordinator.dispose()
  })
})
