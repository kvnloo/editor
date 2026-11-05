'use client'

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DeepZoomViewer } from '../../packages/editor/src/components/deep-zoom-viewer'
import {
  assertDeepzoomAbabSource,
  createDeepzoomAbabBridge,
  type DeepzoomAbabViewer,
} from './deepzoom-abab-harness-bridge'

declare global {
  interface Window {
    __deepzoomAbab?: ReturnType<typeof createDeepzoomAbabBridge>
  }
}

const host = document.getElementById('root')
if (!host) throw new Error('DeepZoom harness root is missing')
const status = document.getElementById('status')
const params = new URLSearchParams(window.location.search)
const dziUrl = params.get('dzi') ?? ''
const tapeSourceUrl = params.get('tapeSource') ?? ''
const root = createRoot(host)

try {
  assertDeepzoomAbabSource(dziUrl, tapeSourceUrl)
  root.render(
    createElement(DeepZoomViewer, {
      dziUrl,
      onViewerChange: (viewer, makePoint) => {
        delete window.__deepzoomAbab
        if (!viewer) return
        if (!makePoint) throw new Error('OpenSeadragon point constructor is missing')
        window.__deepzoomAbab = createDeepzoomAbabBridge({
          viewer: viewer as DeepzoomAbabViewer,
          dziUrl,
          tapeSourceUrl,
          devicePixelRatio: () => window.devicePixelRatio,
          makePoint,
        })
      },
    }),
  )
} catch (error) {
  if (status) status.textContent = error instanceof Error ? error.message : String(error)
}
