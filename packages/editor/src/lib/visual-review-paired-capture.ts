import { captureSnapshotScene } from '../components/editor/snapshot-capture'
import type { VisualReviewCameraPose, VisualReviewCapture } from './visual-review-receipt'

export type VisualReviewFrameKind = 'source' | 'baked'

/**
 * Opt-in renderer adapter. Each frame renders synchronously into an owned
 * target; readPixels returns tightly packed, top-down, decoded RGBA bytes.
 * prepareFrame registers every scene/camera restoration before changing it.
 */
export interface VisualReviewFrameRenderer {
  prepareFrame(
    kind: VisualReviewFrameKind,
    pose: VisualReviewCameraPose,
    restore: (callback: () => void) => void,
  ): void
  renderFrame(kind: VisualReviewFrameKind): void
  getCameraPose(): VisualReviewCameraPose | null
  readPixels(
    width: number,
    height: number,
  ): Uint8Array | Uint8ClampedArray | Promise<Uint8Array | Uint8ClampedArray>
}

export interface VisualReviewPairedCapture {
  source: VisualReviewCapture | null
  baked: VisualReviewCapture | null
  pose: VisualReviewCameraPose
}

function copyPose(pose: VisualReviewCameraPose): VisualReviewCameraPose {
  return {
    position: [...pose.position] as [number, number, number],
    quaternion: [...pose.quaternion] as [number, number, number, number],
    fov: pose.fov,
  }
}

/**
 * Acquires diagnostic frames only. Never encodes, persists, or replaces the
 * normal snapshot/bake Blob path, so saved image hashes stay unchanged.
 * A failed render/readback is inconclusive, not a visual match.
 */
export async function captureVisualReviewPair(
  renderer: VisualReviewFrameRenderer,
  requestedPose: VisualReviewCameraPose,
  { width, height }: { width: number; height: number },
): Promise<VisualReviewPairedCapture> {
  const pose = copyPose(requestedPose)
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4)
  ) {
    return { source: null, baked: null, pose }
  }

  const captureFrame = async (kind: VisualReviewFrameKind): Promise<VisualReviewCapture | null> => {
    try {
      return await captureSnapshotScene((restore) => {
        // Both renders receive independent copies of the SAME requested pose.
        renderer.prepareFrame(kind, copyPose(pose), restore)
        renderer.renderFrame(kind)
        const observed = renderer.getCameraPose()
        const cameraPose = observed ? copyPose(observed) : null

        // The existing capture helper restores synchronously, before an async
        // GPU readback settles; copy bytes before the next pass can reuse them.
        return Promise.resolve(renderer.readPixels(width, height)).then((rgba) => ({
          width,
          height,
          rgba: new Uint8Array(rgba),
          cameraPose,
        }))
      })
    } catch {
      return null
    }
  }

  const source = await captureFrame('source')
  const baked = await captureFrame('baked')
  return { source, baked, pose }
}
