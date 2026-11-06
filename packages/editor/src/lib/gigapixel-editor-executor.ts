import { type GigapixelExportHost, GigapixelExportDenied } from '@pascal-app/core/agent-operations'

type Capture = GigapixelExportHost['exportZip']

/** Pass this same authority-bound instance to the Editor, hosted commands, and MCP. */
export interface EditorGigapixelExportHost extends GigapixelExportHost {
  attachCapture(capture: Capture): () => void
}

export function createEditorGigapixelExportHost(
  authority: Pick<GigapixelExportHost, 'getActiveProjectId' | 'authorizeGigapixelExport'>,
): EditorGigapixelExportHost {
  let capture: Capture | undefined
  return {
    ...authority,
    exportZip(request) {
      if (!capture) {
        throw new GigapixelExportDenied('export_unavailable', 'No trusted editor renderer is mounted')
      }
      request.signal?.throwIfAborted()
      return capture(request)
    },
    attachCapture(next) {
      if (capture) throw new Error('A DeepZoom export renderer is already mounted')
      capture = next
      return () => {
        if (capture === next) capture = undefined
      }
    },
  }
}
