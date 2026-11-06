import { describe, expect, test } from 'bun:test'
import { createFitSceneControlsCoordinator } from '@pascal-app/editor'

type LookAtCall = [number, number, number, number, number, number, boolean]

function manualFrames() {
  const scheduled = new Map<number, () => void>()
  let nextFrame = 0

  return {
    requestFrame: (callback: () => void) => {
      const id = ++nextFrame
      scheduled.set(id, callback)
      return id
    },
    cancelFrame: (id: number) => {
      scheduled.delete(id)
    },
    advance: () => {
      const callbacks = [...scheduled.values()]
      scheduled.clear()
      for (const callback of callbacks) callback()
    },
  }
}

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
  test('cold-load fit replaces the empty pose while orbit controls are not mounted', () => {
    const mode = { isFirstPersonMode: false, isPreviewMode: false }
    const frames = manualFrames()
    const calls: LookAtCall[] = []
    const coordinator = createFitSceneControlsCoordinator({
      getMode: () => mode,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    coordinator.onFitScene(null)
    coordinator.onFitScene({ center: [10, 20], size: [30, 40] })
    frames.advance()
    expect(calls).toHaveLength(0)

    coordinator.attachControls({
      setLookAt: (...args: LookAtCall) => {
        calls.push(args)
      },
    })
    frames.advance()

    expect(calls).toHaveLength(1)
    const pose = calls[0]
    if (!pose) throw new Error('Populated cold-load fit was not applied')
    for (const [index, expected] of [49.2, 32, 59.2, 10, 0, 20].entries()) {
      expect(pose[index]).toBeCloseTo(expected, 6)
    }
    expect(pose[6]).toBe(true)
    frames.advance()
    expect(calls).toHaveLength(1)
    coordinator.dispose()
  })

  test('navigation away cancels an old fit and return applies only the new scene', () => {
    const mode = { isFirstPersonMode: true, isPreviewMode: false }
    const frames = manualFrames()
    const outgoingCalls: LookAtCall[] = []
    const incomingCalls: LookAtCall[] = []
    const outgoing = createFitSceneControlsCoordinator({
      getMode: () => mode,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })

    outgoing.onFitScene({ center: [10, 20], size: [30, 40] })
    mode.isFirstPersonMode = false
    outgoing.onOrbitResume()
    outgoing.attachControls({
      setLookAt: (...args: LookAtCall) => {
        outgoingCalls.push(args)
      },
    })
    outgoing.dispose()
    frames.advance()
    expect(outgoingCalls).toHaveLength(0)

    mode.isFirstPersonMode = true
    const incoming = createFitSceneControlsCoordinator({
      getMode: () => mode,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    })
    incoming.onFitScene({ center: [50, -10], size: [20, 10] })
    mode.isFirstPersonMode = false
    incoming.onOrbitResume()
    frames.advance()
    expect(incomingCalls).toHaveLength(0)

    incoming.attachControls({
      setLookAt: (...args: LookAtCall) => {
        incomingCalls.push(args)
      },
    })
    frames.advance()
    expect(incomingCalls).toHaveLength(1)
    const pose = incomingCalls[0]
    if (!pose) throw new Error('Return-navigation fit was not applied')
    for (const [index, expected] of [69.6, 16, 9.6, 50, 0, -10].entries()) {
      expect(pose[index]).toBeCloseTo(expected, 6)
    }
    expect(pose[6]).toBe(true)
    frames.advance()
    expect(outgoingCalls).toHaveLength(0)
    expect(incomingCalls).toHaveLength(1)
    incoming.dispose()
  })
})
