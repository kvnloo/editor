'use client'

import { deepZoomTilesUrl } from '@pascal-app/viewer/capture'
import { useEffect, useRef } from 'react'
import { deepZoomViewerOptions } from './deep-zoom-viewer-options'

export function DeepZoomViewer({ dziUrl }: { dziUrl: string }) {
  const container = useRef<HTMLDivElement>(null)

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
    }

    void open().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error('DeepZoom viewer could not open', error)
    })

    return () => {
      controller.abort()
      viewer?.destroy()
    }
  }, [dziUrl])

  return <div className="h-full w-full" ref={container} />
}
