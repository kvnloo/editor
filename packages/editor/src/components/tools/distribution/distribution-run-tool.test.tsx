import { expect, test } from 'bun:test'
import { type AnyNodeId, emitter, type GridEvent, useScene, WallNode } from '@pascal-app/core'
import { type EditorGridEvent, useEditor, useInteractionScope } from '@pascal-app/editor'
import {
  type RunPoint,
  type ScenePort,
  useDistributionRunTool,
} from '@pascal-app/editor/distribution'
import { useThree } from '@react-three/fiber'
import { act, create } from '@react-three/test-renderer'

test.each(['duct-segment', 'pipe-segment'] as const)(
  '%s releases its wall plane after an outward commit and retains it along the wall',
  async (toolName) => {
    const previousScene = useScene.getState()
    const previousEditor = useEditor.getState()
    const previousScope = useInteractionScope.getState()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousActEnvironment = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    )
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
    const wall = WallNode.parse({ parentId: 'level_test', start: [0, 0], end: [10, 0] })
    let tool: ReturnType<typeof useDistributionRunTool> | undefined
    const commits: Array<[number, number, number]> = []
    let acceptCommit = true
    function Host() {
      const { gl } = useThree()
      gl.domElement.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect
      tool = useDistributionRunTool({
        active: true,
        levelId: 'level_test',
        toolName,
        getPorts: () => [],
        findBody: () => null,
        surfaceClearance: () => 0.1,
        commit: ({ end }) => {
          if (!acceptCommit) return null
          commits.push(end)
          return { nextStart: end, nextConnection: { port: null, body: null } }
        },
      })
      return null
    }
    let renderer: Awaited<ReturnType<typeof create>> | undefined
    const wallEvent = (x: number): GridEvent => ({
      position: [x, 1, 0],
      localPosition: [x, 1, 0],
      surfaceNormal: [0, 0, 1],
      surfaceHit: {
        kind: 'wall',
        hostId: wall.id,
        levelId: 'level_test',
        face: 'side',
        side: 'front',
      },
      nativeEvent: {} as GridEvent['nativeEvent'],
    })
    try {
      useScene.setState({ nodes: { [wall.id]: wall } })
      useEditor.setState({ snappingModeByContext: { wall: 'off', polygon: 'off', item: 'off' } })
      renderer = await create(<Host />)
      await act(async () => {
        emitter.emit('grid:click', wallEvent(1))
      })
      await act(async () => {
        emitter.emit('grid:click', wallEvent(2))
      })
      expect(commits).toEqual([[2, 1, 0.1]])
      await act(async () => {
        emitter.emit('grid:move', {
          position: [3, 0, 4],
          localPosition: [3, 0, 4],
          localRay: { origin: [3, 2, 2.1], direction: [0, -0.5, -1] },
          nativeEvent: {} as GridEvent['nativeEvent'],
        })
      })
      expect(tool?.cursor?.[2]).toBeCloseTo(0.1)
      await act(async () => {
        tool?.onDirectionSelect([0, 0, 1])
      })
      const outward: GridEvent = {
        position: [2, 0, 2.1],
        localPosition: [2, 0, 2.1],
        localRay: { origin: [2, 3, 2.1], direction: [0, -1, 0] },
        nativeEvent: {} as GridEvent['nativeEvent'],
      }
      acceptCommit = false
      await act(async () => {
        emitter.emit('grid:click', outward)
      })
      expect(commits).toHaveLength(1)
      acceptCommit = true
      await act(async () => {
        emitter.emit('grid:click', outward)
      })
      expect(commits[1]?.[2]).toBeCloseTo(2.1)
      await act(async () => {
        emitter.emit('grid:move', {
          ...outward,
          localRay: { origin: [4, 3, 2.1], direction: [0, -1, 0] },
        })
      })
      expect(tool?.cursor).toEqual([4, 1, 2.1])
      expect(tool?.surfaceTarget).toBeNull()
    } finally {
      await renderer?.unmount()
      useScene.setState(previousScene, true)
      useEditor.setState(previousEditor, true)
      useInteractionScope.setState(previousScope, true)
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousActEnvironment)
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment)
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    }
  },
)

test.each(['duct-segment', 'pipe-segment'] as const)(
  '%s routes at an exact elevation and updates a vertical target without pointer movement',
  async (toolName) => {
    const previousEditor = useEditor.getState()
    const previousScope = useInteractionScope.getState()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Object.defineProperty(globalThis, 'window', {
      value: new EventTarget(),
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
      writable: true,
    })
    let tool: ReturnType<typeof useDistributionRunTool> | undefined
    const commits: Array<[number, number, number]> = []
    let routingMode: 'horizontal' | 'vertical' = 'horizontal'
    let targetElevation = 4
    function Host() {
      const { gl } = useThree()
      gl.domElement.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect
      tool = useDistributionRunTool({
        active: true,
        levelId: 'level_test',
        toolName,
        routingMode,
        elevation: 2,
        targetElevation,
        getPorts: () => [],
        findBody: () => null,
        commit: ({ end }) => {
          commits.push(end)
          return { nextStart: end, nextConnection: { port: null, body: null } }
        },
      })
      return null
    }
    let renderer: Awaited<ReturnType<typeof create>> | undefined
    const event = (x: number): GridEvent => ({
      position: [x, 0, 0],
      localPosition: [x, 0, 0],
      nativeEvent: {} as GridEvent['nativeEvent'],
    })
    try {
      useEditor.setState({ snappingModeByContext: { wall: 'off', polygon: 'off', item: 'off' } })
      useEditor.getState().showView('2d')
      renderer = await create(<Host />)
      await act(async () => {
        emitter.emit('grid:click', event(1))
      })
      expect(tool?.start).toEqual([1, 2, 0])
      await act(async () => {
        emitter.emit('grid:click', event(3))
      })
      expect(commits).toEqual([[3, 2, 0]])
      await act(async () => {
        const planEvent: EditorGridEvent = {
          ...event(7),
          screenProjection: { pointer: [120, 180], localToScreen: [1, 0, 0, 1, 0, 0] },
        }
        emitter.emit('grid:move', planEvent)
      })
      expect(tool?.cursorScreen).toEqual({ x: 120, y: 180, depth: 0 })
      await act(async () => useEditor.getState().showView('3d'))
      expect(tool?.cursorScreen).toBeNull()
      routingMode = 'vertical'
      await renderer.update(<Host />)
      expect(tool?.cursor).toEqual([3, 4, 0])
      targetElevation = 5
      await renderer.update(<Host />)
      expect(tool?.cursor).toEqual([3, 5, 0])
      await act(async () => {
        emitter.emit('grid:click', event(7))
      })
      expect(commits.at(-1)).toEqual([3, 5, 0])
    } finally {
      await renderer?.unmount()
      useEditor.setState(previousEditor)
      useInteractionScope.setState(previousScope)
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    }
  },
)

test.each(['2d', '3d'] as const)(
  'graded horizontal waste routes snap only to matching-height connections in %s',
  async (view) => {
    const previousScene = useScene.getState()
    const previousEditor = useEditor.getState()
    const previousScope = useInteractionScope.getState()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Object.defineProperty(globalThis, 'window', {
      value: new EventTarget(),
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
      writable: true,
    })

    const collar: ScenePort = {
      nodeId: 'pipe_existing' as AnyNodeId,
      id: 'end',
      position: [4, 2, 0],
      direction: [-1, 0, 0],
      diameter: 2,
      system: 'waste',
    }
    let gradePercent = 0
    let connectionY = 2
    let connectionKind: 'port' | 'body' = 'port'
    let tool: ReturnType<typeof useDistributionRunTool> | undefined

    function Host() {
      const { gl } = useThree()
      gl.domElement.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 600, height: 300 }) as DOMRect
      tool = useDistributionRunTool({
        active: true,
        levelId: 'level_test',
        toolName: 'pipe-segment',
        routingMode: 'horizontal',
        elevation: 2,
        getPorts: () =>
          connectionKind === 'port'
            ? [{ ...collar, position: [4, connectionY, 0] as RunPoint }]
            : [],
        findBody: () =>
          connectionKind === 'body'
            ? { nodeId: collar.nodeId, segmentIndex: 0, point: [4, connectionY, 0] as RunPoint }
            : null,
        resolveFreeEnd: (start, end): RunPoint => [
          end[0],
          start[1] -
            (gradePercent / 100) * Math.hypot(end[0] - start[0], end[2] - start[2]),
          end[2],
        ],
        commit: ({ end }) => ({
          nextStart: end,
          nextConnection: { port: null, body: null },
        }),
      })
      return null
    }

    const event = (x: number): EditorGridEvent => ({
      position: [x, 0, 0],
      localPosition: [x, 0, 0],
      nativeEvent: {} as GridEvent['nativeEvent'],
      screenProjection: {
        pointer: [x * 50, 0],
        localToScreen: [50, 0, 0, 50, 0, 0],
      },
    })
    let renderer: Awaited<ReturnType<typeof create>> | undefined
    try {
      useEditor.setState({
        snappingModeByContext: { wall: 'grid', polygon: 'grid', item: 'grid' },
      })
      useEditor.getState().showView(view)
      renderer = await create(<Host />)
      await act(async () => {
        emitter.emit('grid:click', event(0))
      })
      expect(tool?.start).toEqual([0, 2, 0])

      for (const kind of ['port', 'body'] as const) {
        for (const scenario of [
          { gradePercent: 0, connectionY: 2, shouldConnect: true },
          { gradePercent: 3, connectionY: 1.88, shouldConnect: true },
          { gradePercent: 3, connectionY: 2, shouldConnect: false },
        ]) {
          connectionKind = kind
          gradePercent = scenario.gradePercent
          connectionY = scenario.connectionY
          await act(async () => {
            emitter.emit('grid:move', event(4))
          })
          expect(tool?.endConnection.port?.nodeId ?? null).toBe(
            kind === 'port' && scenario.shouldConnect ? collar.nodeId : null,
          )
          expect(tool?.endConnection.body?.nodeId ?? null).toBe(
            kind === 'body' && scenario.shouldConnect ? collar.nodeId : null,
          )
          expect(tool?.cursor?.[1]).toBeCloseTo(2 - (4 * scenario.gradePercent) / 100, 6)
        }
      }
    } finally {
      await renderer?.unmount()
      useScene.setState(previousScene, true)
      useEditor.setState(previousEditor, true)
      useInteractionScope.setState(previousScope, true)
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct)
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    }
  },
)
