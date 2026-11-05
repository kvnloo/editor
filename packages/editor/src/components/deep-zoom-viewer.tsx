'use client'

import { deepZoomTilesUrl } from '@pascal-app/viewer/capture'
import { useEffect, useRef } from 'react'
import { deepZoomViewerOptions } from './deep-zoom-viewer-options'
import { DeepZoomRefinementScheduler } from './editor/deepzoom-refinement'

export function DeepZoomViewer({ dziUrl }: { dziUrl: string }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    let viewer: { destroy(): void } | null = null
    let refinement: DeepZoomRefinementScheduler<() => void> | null = null

    const open = async () => {
      const response = await fetch(dziUrl, { signal: controller.signal })
      if (!response.ok) throw new Error('DeepZoom descriptor request failed: ' + response.status)

      const descriptor = await response.text()
      const options = deepZoomViewerOptions(descriptor, deepZoomTilesUrl(dziUrl))
      const { default: OpenSeadragon } = await import('openseadragon')
      if (controller.signal.aborted || !container.current) return

      const instance = OpenSeadragon({ element: container.current, ...options })
      viewer = instance
      const release = (tiles: readonly { value: () => void }[]) => {
        for (const tile of tiles) tile.value()
      }

      const scheduler = new DeepZoomRefinementScheduler<() => void>(
        {
          now: () => performance.now(),
          setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
          clearTimeout: (handle) => window.clearTimeout(handle),
        },
        {
          publish: (_generation, tiles) => release(tiles),
          discard: release,
        },
      )
      refinement = scheduler

      const onMotion = () => {
        const homeZoom = instance.viewport.getHomeZoom()
        const ratio = homeZoom > 0 ? instance.viewport.getZoom(true) / homeZoom : 1
        scheduler.motion(ratio)
      }

      instance.addHandler('open', onMotion)
      instance.addHandler('viewport-change', onMotion)
      // OpenSeadragon awaits tile-loaded promises before making those tiles drawable.
      instance.addHandler('tile-loaded', (event) => {
        const generation = scheduler.generation
        if (generation === null || scheduler.isSettled) return
        const tile = event.tile
        const id = tile.level + '/' + tile.x + '_' + tile.y
        return new Promise<void>((resume) => {
          if (!scheduler.stage(generation, id, resume)) resume()
        })
      })
    }

    void open().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('DeepZoom viewer could not open', error)
    })

    return () => {
      controller.abort()
      refinement?.dispose()
      viewer?.destroy()
    }
  }, [dziUrl])

  return <div className="h-full w-full" ref={container} />
}
