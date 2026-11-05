import { describe, expect, test } from 'bun:test'
import {
  assertDeepzoomAbabSource,
  createDeepzoomAbabBridge,
} from './deepzoom-abab-harness-bridge'

const signedDzi = 'https://images.example.test/campus.dzi?token=kept'

type Listener = (event: unknown) => void

class Events {
  private readonly handlers = new Map<string, Set<Listener>>()

  addHandler(name: string, listener: Listener) {
    const listeners = this.handlers.get(name) ?? new Set<Listener>()
    listeners.add(listener)
    this.handlers.set(name, listeners)
  }

  removeHandler(name: string, listener: Listener) {
    this.handlers.get(name)?.delete(listener)
  }

  emit(name: string, event: unknown = {}) {
    for (const listener of this.handlers.get(name) ?? []) listener(event)
  }
}

function fakeViewer(width: number, height: number) {
  let currentZoom = 1
  const tile = new Events()
  const pans: { x: number; y: number; immediate: boolean | undefined }[] = []
  const zooms: number[] = []
  const constraints: (boolean | undefined)[] = []

  const viewer = Object.assign(new Events(), {
    container: { getBoundingClientRect: () => ({ width, height }) },
    viewport: {
      zoomTo(zoom: number, _refPoint?: { x: number; y: number }, _immediately?: boolean) {
        currentZoom = zoom
        zooms.push(zoom)
      },
      getZoom: () => currentZoom,
      panBy(point: { x: number; y: number }, immediate?: boolean) {
        pans.push({ ...point, immediate })
      },
      applyConstraints(immediate?: boolean) {
        constraints.push(immediate)
      },
    },
    world: { getItemCount: () => 1, getItemAt: () => tile },
  })
  return { viewer, tile, pans, zooms, constraints }
}

describe('OpenSeadragon ABAB dev harness bridge', () => {
  for (const width of [800, 400]) {
    for (const dpr of [1, 2]) {
      test('maps CSS pan to viewport units at width ' + width + ' and DPR ' + dpr, () => {
        const fake = fakeViewer(width, width === 800 ? 450 : 300)
        const bridge = createDeepzoomAbabBridge({
          viewer: fake.viewer,
          dziUrl: signedDzi,
          tapeSourceUrl: signedDzi,
          devicePixelRatio: () => dpr,
          makePoint: (x, y) => ({ x, y }),
        })

        bridge.applyViewportStep({ zoom: 2, panX: 20, panY: -10 })
        const expected = width === 800 ? { x: 0.0125, y: -0.00625 } : { x: 0.025, y: -0.0125 }
        expect(fake.zooms).toEqual([2])
        expect(fake.pans).toEqual([{ ...expected, immediate: true }])
        expect(fake.constraints).toEqual([true])
        expect(bridge.sourceUrl).toBe(signedDzi)
      })
    }
  }

  test('refuses a descriptor whose signed query differs from the tape', () => {
    const fake = fakeViewer(800, 450)
    const changed = 'https://images.example.test/campus.dzi?token=other'
    expect(() => assertDeepzoomAbabSource(changed, signedDzi)).toThrow('different DZI URL')
    expect(() =>
      createDeepzoomAbabBridge({
        viewer: fake.viewer,
        dziUrl: changed,
        tapeSourceUrl: signedDzi,
        devicePixelRatio: () => 1,
        makePoint: (x, y) => ({ x, y }),
      }),
    ).toThrow('different DZI URL')
    expect(fake.zooms).toEqual([])
  })

  test('exposes and cleans up v5 viewer tile and TiledImage completion hooks', () => {
    const fake = fakeViewer(800, 450)
    const bridge = createDeepzoomAbabBridge({
      viewer: fake.viewer,
      dziUrl: signedDzi,
      tapeSourceUrl: signedDzi,
      devicePixelRatio: () => 1,
      makePoint: (x, y) => ({ x, y }),
    })
    const tileEvents: unknown[] = []
    const completeEvents: unknown[] = []
    const removeTile = bridge.onTileLoaded((event) => tileEvents.push(event))
    const removeComplete = bridge.onFullyLoadedChange((event) => completeEvents.push(event))

    fake.viewer.emit('tile-loaded', { tile: 1 })
    fake.tile.emit('fully-loaded-change', { fullyLoaded: true })
    expect(tileEvents).toEqual([{ tile: 1 }])
    expect(completeEvents).toEqual([{ fullyLoaded: true }])

    removeTile()
    removeComplete()
    fake.viewer.emit('tile-loaded', { tile: 2 })
    fake.tile.emit('fully-loaded-change', { fullyLoaded: false })
    expect(tileEvents).toHaveLength(1)
    expect(completeEvents).toHaveLength(1)
  })
})
