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
  const activeExports = new Set<AbortController>()
  return {
    ...authority,
    async exportZip(request) {
      const mountedCapture = capture
      if (!mountedCapture) {
        throw new GigapixelExportDenied('export_unavailable', 'No trusted editor renderer is mounted')
      }
      request.signal?.throwIfAborted()
      const controller = new AbortController()
      const forwardAbort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', forwardAbort, { once: true })
      if (request.signal?.aborted) forwardAbort()
      activeExports.add(controller)
      try {
        controller.signal.throwIfAborted()
        const artifact = await mountedCapture({ ...request, signal: controller.signal })
        if (controller.signal.aborted) {
          await artifact.rollback()
          controller.signal.throwIfAborted()
        }
        return artifact
      } finally {
        activeExports.delete(controller)
        request.signal?.removeEventListener('abort', forwardAbort)
      }
    },
    attachCapture(next) {
      if (capture) throw new Error('A DeepZoom export renderer is already mounted')
      capture = next
      return () => {
        if (capture !== next) return
        capture = undefined
        for (const controller of activeExports) {
          controller.abort(
            new GigapixelExportDenied('export_unavailable', 'DeepZoom renderer detached during export'),
          )
        }
      }
    },
  }
}
