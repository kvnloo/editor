'use client'

import { deepZoomTilesUrl } from '@pascal-app/viewer/capture'
import { useEffect, useRef } from 'react'
import { deepZoomViewerOptions } from './deep-zoom-viewer-options'

export function DeepZoomViewer({
  dziUrl,
  onViewerChange,
}: {
  dziUrl: string
  onViewerChange?: (
    viewer: unknown | null,
    makePoint?: (x: number, y: number) => { x: number; y: number },
  ) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const viewerChange = useRef(onViewerChange)
  viewerChange.current = onViewerChange

  useEffect(() => {
    const controller = new AbortController()
    let viewer: { destroy(): void } | null = null

    const open = async () => {
      const response = await fetch(dziUrl, { signal: controller.signal })
      if (!response.ok) throw new Error('DeepZoom descriptor request failed: ' + response.status)

      const descriptor = await response.text()
      const options = deepZoomViewerOptions(descriptor, deepZoomTilesUrl(dziUrl))
      const { default: OpenSeadragon } = await import('openseadragon')
      if (controller.signal.aborted || !container.current) return

      viewer = OpenSeadragon({ element: container.current, ...options })
      viewerChange.current?.(viewer, (x, y) => new OpenSeadragon.Point(x, y))
    }

    void open().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('DeepZoom viewer could not open', error)
    })

    return () => {
      controller.abort()
      if (viewer) viewerChange.current?.(null)
      viewer?.destroy()
    }
  }, [dziUrl])

  return <div className="h-full w-full" ref={container} />
}
