import { describe, expect, test } from 'bun:test'
import {
  clearSceneHistory,
  emitter,
  type GridEvent,
  nodeRegistry,
  PipeSegmentNode,
  registerNode,
  useScene,
} from '@pascal-app/core'
import { useEditor } from '@pascal-app/editor'
import { pipeSegmentDefinition } from '@pascal-app/nodes'
import { useViewer } from '@pascal-app/viewer'
import { act, create } from '@react-three/test-renderer'
import { createElement } from 'react'
import { buildPipeSegmentFloorplan } from './floorplan'

describe('pipe segment defaults', () => {
  test('declares surface-aware, history-cancellable drafting behavior', () => {
    expect(pipeSegmentDefinition.drafting).toEqual({
      surfaceQuery: true,
      cancelOnHistoryJump: true,
    })
  })

  test('rests a level pipe on top of the support grid', () => {
    const pipe = pipeSegmentDefinition.defaults()
    const radius = (pipe.diameter * 0.0254) / 2

    expect(pipe.path[0]?.[1]).toBeCloseTo(radius)
    expect(pipe.path[1]?.[1]).toBeCloseTo(radius)
  })

  test('shows click-only continuation plus handles beyond selected plan endpoints', () => {
    const pipe = PipeSegmentNode.parse({
      ...pipeSegmentDefinition.defaults(),
      path: [
        [0, 0.0254, 0],
        [2, 0.0254, 0],
      ],
    })
    const geometry = buildPipeSegmentFloorplan(pipe, {
      viewState: { selected: true },
    } as never)
    const handles =
      geometry?.kind === 'group'
        ? geometry.children.filter(
            (child) =>
              child.kind === 'midpoint-handle' &&
              child.activation === 'action' &&
              child.affordance === 'continue-run',
          )
        : []

    expect(handles).toHaveLength(2)
    const points = handles.map((handle) => handle.kind === 'midpoint-handle' && handle.point)
    expect(points[0]?.[0]).toBeCloseTo(-0.28)
    expect(points[0]?.[1]).toBeCloseTo(0)
    expect(points[1]?.[0]).toBeCloseTo(2.28)
    expect(points[1]?.[1]).toBeCloseTo(0)
  })
})

test('a refused connected pipe move restores history for the next edit', async () => {
  const originalScene = useScene.getState()
  const originalEditor = useEditor.getState()
  const originalViewer = useViewer.getState()
  const restoreRegistry = nodeRegistry._snapshot()
  const originalNow = Date.now
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  let now = 1000
  Date.now = () => now
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: new EventTarget(),
    configurable: true,
    writable: true,
  })

  const moving = PipeSegmentNode.parse({
    ...pipeSegmentDefinition.defaults(),
    path: [[0, 2, 0], [4, 2, 0]],
    system: 'waste',
  })
  const follower = PipeSegmentNode.parse({
    ...pipeSegmentDefinition.defaults(),
    path: [[4, 2, 0], [8, 1.88, 0]],
    system: 'waste',
  })
  let renderer: Awaited<ReturnType<typeof create>> | undefined
  try {
    registerNode(pipeSegmentDefinition)
    useScene.setState({ nodes: { [moving.id]: moving, [follower.id]: follower }, readOnly: false })
    clearSceneHistory()
    useEditor.setState({
      snappingModeByContext: { wall: 'off', polygon: 'off', item: 'off' },
    })
    const moveTool = await pipeSegmentDefinition.affordanceTools?.move?.()
    if (!moveTool) throw new Error('Pipe move affordance is not registered')
    renderer = await create(createElement(moveTool.default, { node: moving }))
    expect(useScene.temporal.getState().isTracking).toBe(false)

    // Moving the 0%-grade run +5m reverses the connected 3%-grade follower.
    const event: GridEvent = {
      position: [7, 0, 0],
      localPosition: [7, 0, 0],
      nativeEvent: {} as GridEvent['nativeEvent'],
    }
    await act(async () => {
      emitter.emit('grid:move', event)
    })
    now = 1200
    await act(async () => {
      emitter.emit('grid:click', event)
    })

    expect(useScene.getState().nodes[moving.id]).toEqual(moving)
    expect(useScene.getState().nodes[follower.id]).toEqual(follower)
    expect(useScene.temporal.getState().isTracking).toBe(true)
    expect(useScene.temporal.getState().pastStates).toHaveLength(0)

    useScene.getState().updateNodes([{ id: follower.id, data: { diameter: 3 } }])
    expect(useScene.getState().nodes[follower.id]).toMatchObject({ diameter: 3 })
    expect(useScene.temporal.getState().pastStates).toHaveLength(1)
    useScene.temporal.getState().undo()
    expect(useScene.getState().nodes[follower.id]).toMatchObject({
      diameter: follower.diameter,
      path: follower.path,
    })
  } finally {
    await renderer?.unmount()
    useScene.setState(originalScene, true)
    useEditor.setState(originalEditor, true)
    useViewer.setState(originalViewer, true)
    clearSceneHistory()
    restoreRegistry()
    Date.now = originalNow
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (originalAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalAct)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  }
})
