import type { EditorProps } from '@pascal-app/editor'
import { downloadSnapshot } from './snapshot-download'

interface SceneThumbnailSource {
  id: string
  name: string
  projectId: string | null
}

type ThumbnailCallback = NonNullable<EditorProps['onThumbnailCapture']>
type ThumbnailCapture = (...args: Parameters<ThumbnailCallback>) => Promise<void>

interface ThumbnailHostDependencies {
  download?: typeof downloadSnapshot
  upload?: (sceneId: string, blob: Blob) => Promise<void>
}

async function uploadThumbnail(sceneId: string, blob: Blob) {
  await fetch(`/api/scenes/${sceneId}/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  })
}

/** The callback passed to the public <Editor onThumbnailCapture> host boundary. */
export function createSceneThumbnailCapture(
  meta: SceneThumbnailSource,
  { download = downloadSnapshot, upload = uploadThumbnail }: ThumbnailHostDependencies = {},
): ThumbnailCapture {
  return async (blob, cameraData) => {
    if (cameraData.captureMode) {
      await download(meta.projectId ?? 'default', meta.name, blob, cameraData)
      return
    }
    if (cameraData.requestId) return
    await upload(meta.id, blob).catch(() => {})
  }
}
