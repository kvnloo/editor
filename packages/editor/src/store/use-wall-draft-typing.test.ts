import { resolveWallDraftClickPoint } from '@pascal-app/editor'
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  acceptsWallTypingKey,
  isWallTypingKey,
  resolveTypedCommitEnd,
  useWallDraftTyping,
} from './use-wall-draft-typing'

describe('useWallDraftTyping', () => {
  beforeEach(() => {
    useWallDraftTyping.getState().clearInput()
  })

  test('append accumulates a measurement buffer', () => {
    const typing = useWallDraftTyping.getState()
    typing.append('1')
    typing.append('8')
    typing.append('0')
    typing.append('c')
    typing.append('m')
    expect(useWallDraftTyping.getState().input).toBe('180cm')
  })

  test('backspace removes the last character', () => {
    const typing = useWallDraftTyping.getState()
    typing.append('2')
    typing.append('5')
    typing.backspace()
    expect(useWallDraftTyping.getState().input).toBe('2')
  })

  test('clearInput empties the buffer and the projected end', () => {
    const typing = useWallDraftTyping.getState()
    typing.append('5')
    typing.setProjectedEnd([1.5, 2.5])
    typing.clearInput()
    expect(useWallDraftTyping.getState().input).toBe('')
    expect(useWallDraftTyping.getState().projectedEnd).toBeNull()
  })

  test('setProjectedEnd stores the committed endpoint for click parity', () => {
    useWallDraftTyping.getState().setProjectedEnd([3.2, -0.4])
    expect(useWallDraftTyping.getState().projectedEnd).toEqual([3.2, -0.4])
  })
})

describe('resolveTypedCommitEnd', () => {
  const opts = { bareUnit: 'm', system: 'metric' } as const

  test('re-derives the endpoint from the buffer, not the stale preview length', () => {
    // Pointer last projected the "1" buffer (1 m east); user then typed "2"
    // without moving. The commit must be 12 m east, not 1 m.
    const end = resolveTypedCommitEnd([0, 0], [1, 0], '12', opts)
    expect(end).toEqual([12, 0])
  })

  test('normalizes the direction before applying the typed length', () => {
    // Stale preview end is 5 m along a 3-4-5 diagonal; typed 6 must scale the
    // unit vector, not add 6 to the stale endpoint.
    const end = resolveTypedCommitEnd([0, 0], [3, 4], '6', opts)
    expect(end).not.toBeNull()
    expect(end![0]).toBeCloseTo(3.6, 10)
    expect(end![1]).toBeCloseTo(4.8, 10)
  })

  test('honours unit suffixes in the buffer', () => {
    const end = resolveTypedCommitEnd([1, 1], [11, 1], '250cm', opts)
    expect(end).toEqual([3.5, 1])
  })

  test('returns null for empty, unparseable, or non-positive buffers', () => {
    expect(resolveTypedCommitEnd([0, 0], [1, 0], '', opts)).toBeNull()
    expect(resolveTypedCommitEnd([0, 0], [1, 0], 'abc', opts)).toBeNull()
    expect(resolveTypedCommitEnd([0, 0], [1, 0], '0', opts)).toBeNull()
  })

  test('returns null when the preview end is still on the start point', () => {
    expect(resolveTypedCommitEnd([2, 2], [2, 2], '5', opts)).toBeNull()
  })
})

describe('isWallTypingKey', () => {
  test('accepts digits, unit letters, and separators', () => {
    for (const key of ['0', '9', 'm', 'c', '.', "'", '"', '-', ' ']) {
      expect(isWallTypingKey(key)).toBe(true)
    }
  })

  test('rejects modifiers and multi-key names', () => {
    for (const key of ['Enter', 'Escape', 'Tab', 'Shift', '', 'F1']) {
      expect(isWallTypingKey(key)).toBe(false)
    }
  })
})

describe('acceptsWallTypingKey (start gating, Bugbot 7dcff331)', () => {
  test('a digit or leading dot may start a buffer', () => {
    expect(acceptsWallTypingKey('5', '')).toBe(true)
    expect(acceptsWallTypingKey('.', '')).toBe(true)
  })

  test('letters and separators cannot start a buffer — drafting shortcuts stay live', () => {
    // `c` (continuation), `m`, `t`, `f`… must reach the shortcut layer while
    // the second click is pending and no buffer exists.
    for (const key of ['c', 'm', 't', 'f', '-', ' ']) {
      expect(acceptsWallTypingKey(key, '')).toBe(false)
    }
  })

  test('anything isWallTypingKey accepts may continue an active buffer', () => {
    expect(acceptsWallTypingKey('c', '180')).toBe(true)
    expect(acceptsWallTypingKey('m', '180c')).toBe(true)
    expect(acceptsWallTypingKey('.', '2')).toBe(true)
  })
})

const metric = { bareUnit: 'm', system: 'metric' } as const

function clickPoint(input: string, projectedEnd: [number, number] | null) {
  return resolveWallDraftClickPoint({
    start: [0, 0],
    currentEnd: [1, 0],
    rawPoint: [7, 0],
    input,
    projectedEnd,
    options: metric,
  })
}

describe('wall draft click length contract', () => {
  test('commits the latest 12 m buffer instead of the stale 1 m preview', () => {
    expect(clickPoint('12', [1, 0])).toEqual([12, 0])
  })

  test('refuses zero with a stale cached endpoint', () => {
    expect(clickPoint('0', [1, 0])).toBeNull()
  })

  test('refuses zero without a cache while preserving an untyped click', () => {
    expect(clickPoint('0', null)).toBeNull()
    expect(clickPoint('', null)).toEqual([7, 0])
  })

  test('refuses an unparseable nonempty buffer', () => {
    expect(clickPoint('abc', [1, 0])).toBeNull()
  })

  test('uses a cached direction only after recomputing the valid typed length', () => {
    expect(
      resolveWallDraftClickPoint({
        start: [0, 0],
        currentEnd: [0, 0],
        rawPoint: [7, 0],
        input: '2',
        projectedEnd: [1, 0],
        options: metric,
      }),
    ).toEqual([2, 0])
  })
})

describe('single-wall view switches', () => {
  test('cancels each typed 2D/3D/split draft once without scene or history writes', () => {
    const preview = useFloorplanDraftPreview.getState()
    const originalView = useEditor.getState().viewMode
    const sceneNodes = useScene.getState().nodes
    const transitions = [
      ['3d', '2d'],
      ['2d', 'split'],
      ['split', '3d'],
      ['3d', 'split'],
      ['split', '2d'],
      ['2d', '3d'],
    ] as const
    const cancels: Array<{ input: string; projectedEnd: [number, number] | null }> = []
    let sceneWrites = 0
    let commits = 0

    preview.setWallDraftStart(null)
    preview.setWallDraftEnd(null)
    preview.setWallPolygonDraftPoints([])
    clearSceneHistory()
    const stopScene = useScene.subscribe((current, previous) => {
      if (current.nodes !== previous.nodes) sceneWrites += 1
    })
    const stopCommits = subscribeSceneCommits(() => {
      commits += 1
    })
    const onCancel = () => {
      const { input, projectedEnd } = useWallDraftTyping.getState()
      cancels.push({ input, projectedEnd })
    }
    emitter.on('tool:cancel', onCancel)

    try {
      for (const [from, to] of transitions) {
        preview.setWallDraftStart(null)
        preview.setWallDraftEnd(null)
        useEditor.getState().setViewMode(from)
        const typing = useWallDraftTyping.getState()
        typing.clearInput()
        preview.setWallDraftStart([0, 0])
        preview.setWallDraftEnd([1, 0])
        typing.append('1')
        typing.append('2')
        typing.setProjectedEnd([1, 0])

        const options = { bareUnit: 'm', system: 'metric' } as const
        expect(
          resolveWallDraftClickPoint({
            start: [0, 0],
            currentEnd: [1, 0],
            rawPoint: [7, 0],
            input: useWallDraftTyping.getState().input,
            projectedEnd: useWallDraftTyping.getState().projectedEnd,
            options,
          }),
        ).toEqual([12, 0])

        const beforeCancels = cancels.length
        let typingResets = 0
        const stopTyping = useWallDraftTyping.subscribe((current, previous) => {
          if (current.input !== previous.input || current.projectedEnd !== previous.projectedEnd) {
            typingResets += 1
          }
        })
        try {
          if (from === '3d' && to === 'split') useEditor.getState().setFloorplanOpen(true)
          else if (from === 'split' && to === '3d') useEditor.getState().toggleFloorplanOpen()
          else useEditor.getState().setViewMode(to)
          useEditor.getState().setViewMode(to)
          // A second adapter's cleanup must not publish another typing reset.
          typing.clearInput()

          expect(useEditor.getState().viewMode).toBe(to)
          expect(cancels.slice(beforeCancels)).toEqual([{ input: '', projectedEnd: null }])
          expect(typingResets).toBe(1)
          expect(
            resolveWallDraftClickPoint({
              start: [10, 0],
              currentEnd: [11, 0],
              rawPoint: [13, 0],
              input: useWallDraftTyping.getState().input,
              projectedEnd: useWallDraftTyping.getState().projectedEnd,
              options,
            }),
          ).toEqual([13, 0])
        } finally {
          stopTyping()
        }
      }

      expect(useScene.getState().nodes).toBe(sceneNodes)
      expect({ sceneWrites, commits }).toEqual({ sceneWrites: 0, commits: 0 })
      expect(useScene.temporal.getState().pastStates).toHaveLength(0)
      expect(useScene.temporal.getState().futureStates).toHaveLength(0)
    } finally {
      emitter.off('tool:cancel', onCancel)
      stopCommits()
      stopScene()
      preview.setWallDraftStart(null)
      preview.setWallDraftEnd(null)
      preview.setWallPolygonDraftPoints([])
      useWallDraftTyping.getState().clearInput()
      useEditor.getState().setViewMode(originalView)
    }
  })
})
