import { beforeEach, describe, expect, test } from 'bun:test'
import {
  ColumnNode,
  isMovable,
  loadPlugin,
  movePlanToward,
  moveToward,
  nodeRegistry,
} from '@pascal-app/core'
import { builtinPlugin, columnDefinition } from '../index'

describe('column definition', () => {
  test('keeps only user-owned handles for lean-to managed columns', () => {
    const column = ColumnNode.parse({
      metadata: {
        managedByLeanTo: 'lean_to_1',
        leanToRole: 'post',
      },
    })
    const handles =
      typeof columnDefinition.handles === 'function'
        ? columnDefinition.handles(column)
        : columnDefinition.handles

    expect(handles.map((handle) => handle.kind)).toEqual(['arc-resize'])
  })

  test('keeps brace and rotation handles for lean-to managed K-brace columns', () => {
    const column = ColumnNode.parse({
      supportStyle: 'k-brace',
      metadata: {
        managedByLeanTo: 'lean_to_1',
        leanToRole: 'post',
      },
    })
    const handles =
      typeof columnDefinition.handles === 'function'
        ? columnDefinition.handles(column)
        : columnDefinition.handles

    expect(handles.map((handle) => handle.kind)).toEqual([
      'linear-resize',
      'linear-resize',
      'arc-resize',
    ])
  })
})

describe('column movement from the built-in plugin', () => {
  beforeEach(async () => {
    nodeRegistry._reset()
    await loadPlugin(builtinPlugin)
  })

  test('managed vertical posts keep their positions in 3D and floor plan', () => {
    const post = ColumnNode.parse({
      position: [0, 0.3, 0],
      metadata: { managedByLeanTo: 'canopy', leanToRole: 'post' },
    })
    expect(isMovable(post)).toBe(false)
    expect(moveToward(post, [0, 0.3, 0], [1, 4, 2], { gridSnap: false })).toEqual([0, 0.3, 0])
    expect(movePlanToward(post, 0.3, [0, 0], [1, 2], { gridSnap: false })).toEqual([0, 0])

    const session = columnDefinition.floorplanMoveTarget?.({
      node: post,
      nodes: { [post.id]: post },
    })
    expect(session?.affectedIds).toEqual([])
    session?.apply({
      planPoint: [1, 2],
      modifiers: { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
    })
    expect(session?.canCommit()).toBe(false)
  })

  test('managed K-brace posts cannot move in the floor plan', () => {
    const post = ColumnNode.parse({
      supportStyle: 'k-brace',
      position: [2, 0.3, 1],
      metadata: { managedByLeanTo: 'canopy', leanToRole: 'post' },
    })
    expect(isMovable(post)).toBe(false)
    expect(movePlanToward(post, 0.3, [2, 1], [2.5, 3], { gridSnap: false })).toEqual([2, 1])
    const session = columnDefinition.floorplanMoveTarget?.({
      node: post,
      nodes: { [post.id]: post },
    })
    expect(session?.affectedIds).toEqual([])
    expect(session?.canCommit()).toBe(false)
  })

  test('unmanaged columns retain X/Z translation with Y locked', () => {
    const column = ColumnNode.parse({ position: [0, 0.3, 0] })
    expect(isMovable(column)).toBe(true)
    expect(moveToward(column, [0, 0.3, 0], [1, 4, 2], { gridSnap: false })).toEqual([1, 0.3, 2])
    expect(movePlanToward(column, 0.3, [0, 0], [1, 2], { gridSnap: false })).toEqual([1, 2])
  })
})
