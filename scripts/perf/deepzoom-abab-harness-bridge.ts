type Point = { x: number; y: number }
type Listener = (event: unknown) => void

interface EventSource {
  addHandler(name: string, listener: Listener): void
  removeHandler(name: string, listener: Listener): void
}

export interface DeepzoomAbabViewer extends EventSource {
  container: { getBoundingClientRect(): { width: number; height: number } }
  viewport: {
    zoomTo(zoom: number, refPoint?: Point, immediately?: boolean): void
    getZoom(immediately?: boolean): number
    panBy(delta: Point, immediately?: boolean): void
    applyConstraints(immediately?: boolean): void
  }
  world: {
    getItemCount(): number
    getItemAt(index: number): EventSource
  }
}

export interface DeepzoomAbabStep {
  zoom: number
  panX: number
  panY: number
}

/** Keep the signed query byte-for-byte identical to the #25 tape source. */
export function assertDeepzoomAbabSource(dziUrl: string, tapeSourceUrl: string): string {
  if (!dziUrl || !tapeSourceUrl || dziUrl !== tapeSourceUrl) {
    throw new Error('Harness has a different DZI URL than the tape')
  }
  let url: URL
  try {
    url = new URL(dziUrl)
  } catch {
    throw new TypeError('Harness DZI URL must be absolute HTTP(S)')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.pathname.toLowerCase().endsWith('.dzi')
  ) {
    throw new TypeError('Harness DZI URL must be absolute HTTP(S) and end in .dzi')
  }
  return dziUrl
}

/**
 * The collector already divides #25 physical-pixel tape values by DPR.
 * OpenSeadragon's viewport uses image-width units for BOTH axes:
 * 1 CSS pixel = 1 / (container CSS width * current viewport zoom).
 * Multiplying both pixel and container width by the actual DPR makes
 * the physical-pixel conversion explicit without dividing twice.
 */
export function createDeepzoomAbabBridge({
  viewer,
  dziUrl,
  tapeSourceUrl,
  devicePixelRatio,
  makePoint,
}: {
  viewer: DeepzoomAbabViewer
  dziUrl: string
  tapeSourceUrl: string
  devicePixelRatio: () => number
  makePoint: (x: number, y: number) => Point
}) {
  const sourceUrl = assertDeepzoomAbabSource(dziUrl, tapeSourceUrl)
  if (
    !viewer?.viewport ||
    typeof viewer.viewport.zoomTo !== 'function' ||
    typeof viewer.viewport.getZoom !== 'function' ||
    typeof viewer.viewport.panBy !== 'function' ||
    typeof viewer.container?.getBoundingClientRect !== 'function' ||
    typeof makePoint !== 'function'
  ) {
    throw new TypeError('Harness needs a live OpenSeadragon viewer and point constructor')
  }

  return {
    sourceUrl,
    viewer,
    applyViewportStep(step: DeepzoomAbabStep) {
      if (
        !step ||
        !Number.isFinite(step.zoom) ||
        step.zoom <= 0 ||
        !Number.isFinite(step.panX) ||
        !Number.isFinite(step.panY)
      ) {
        throw new TypeError('Harness viewport step requires finite zoom and pan coordinates')
      }

      const { width, height } = viewer.container.getBoundingClientRect()
      const dpr = devicePixelRatio()
      if (
        !Number.isFinite(width) ||
        width <= 0 ||
        !Number.isFinite(height) ||
        height <= 0 ||
        !Number.isFinite(dpr) ||
        dpr <= 0
      ) {
        throw new TypeError('Harness needs positive container dimensions and DPR')
      }

      viewer.viewport.zoomTo(step.zoom, undefined, true)
      const zoom = viewer.viewport.getZoom(true)
      if (!Number.isFinite(zoom) || zoom <= 0) {
        throw new TypeError('OpenSeadragon returned an invalid viewport zoom')
      }

      const physicalWidth = width * dpr
      const deltaX = (step.panX * dpr) / (physicalWidth * zoom)
      const deltaY = (step.panY * dpr) / (physicalWidth * zoom)
      viewer.viewport.panBy(makePoint(deltaX, deltaY), true)
      viewer.viewport.applyConstraints(true)
    },
    onTileLoaded(listener: Listener) {
      viewer.addHandler('tile-loaded', listener)
      return () => viewer.removeHandler('tile-loaded', listener)
    },
    onFullyLoadedChange(listener: Listener) {
      const images = Array.from({ length: viewer.world.getItemCount() }, (_, index) =>
        viewer.world.getItemAt(index),
      )
      for (const image of images) image.addHandler('fully-loaded-change', listener)
      return () => {
        for (const image of images) image.removeHandler('fully-loaded-change', listener)
      }
    },
  }
}
