/** One decoded RGBA frame, captured before any lossy encoding. */
export interface VisualReviewCapture {
  width: number
  height: number
  rgba: Uint8Array | Uint8ClampedArray
  cameraPose?: VisualReviewCameraPose | null
}

export interface VisualReviewCameraPose {
  position: readonly [number, number, number]
  quaternion: readonly [number, number, number, number]
  fov: number
}

export interface VisualReviewReceipt {
  status: 'pass' | 'fail' | 'unknown'
  mismatchRatio: number | null
  sourceHash: string | null
  bakedHash: string | null
}

const DEFAULT_POSE_EPSILON = 1e-5
const QUATERNION_NORM_TOLERANCE = 1e-3

function hasValidPixels(
  capture: VisualReviewCapture | null | undefined,
): capture is VisualReviewCapture {
  if (!capture) return false
  const { width, height, rgba } = capture
  const byteCount = width * height * 4
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 0xffffffff &&
    height <= 0xffffffff &&
    Number.isSafeInteger(byteCount) &&
    (rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) &&
    rgba.length === byteCount
  )
}

// This is a reproducible, non-cryptographic content fingerprint. Equality
// verdicts always compare the actual RGBA bytes, never only these hashes.
function hashRgba(capture: VisualReviewCapture): string {
  let hash = 0x811c9dc5
  const mix = (byte: number) => {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }

  for (const dimension of [capture.width, capture.height]) {
    for (let shift = 0; shift < 32; shift += 8) {
      mix((dimension >>> shift) & 0xff)
    }
  }
  for (const byte of capture.rgba) mix(byte)
  return 'fnv1a32:' + hash.toString(16).padStart(8, '0')
}

function hasValidPose(
  pose: VisualReviewCameraPose | null | undefined,
): pose is VisualReviewCameraPose {
  if (
    !pose ||
    pose.position.length !== 3 ||
    pose.quaternion.length !== 4 ||
    !pose.position.every(Number.isFinite) ||
    !pose.quaternion.every(Number.isFinite) ||
    !Number.isFinite(pose.fov) ||
    pose.fov <= 0 ||
    pose.fov >= 180
  ) {
    return false
  }
  const normSquared = pose.quaternion.reduce((sum, component) => sum + component * component, 0)
  return Math.abs(normSquared - 1) <= QUATERNION_NORM_TOLERANCE
}

function hasMatchingPose(
  source: VisualReviewCameraPose,
  baked: VisualReviewCameraPose,
  epsilon: number,
): boolean {
  if (Math.abs(source.fov - baked.fov) > epsilon) return false
  if (
    !source.position.every((value, index) => {
      const other = baked.position[index]
      return other !== undefined && Math.abs(value - other) <= epsilon
    })
  ) {
    return false
  }

  // q and -q encode the same camera orientation.
  return [1, -1].some((sign) =>
    source.quaternion.every((value, index) => {
      const other = baked.quaternion[index]
      return other !== undefined && Math.abs(value - sign * other) <= epsilon
    }),
  )
}

/**
 * Compare two uncompressed, identically framed RGBA captures pixel by pixel.
 * A pixel mismatches when any of its four channels differs. A missing/invalid
 * frame, different dimensions or unverifiable camera pose is inconclusive.
 */
export function compareVisualReviewCaptures(
  source: VisualReviewCapture | null | undefined,
  baked: VisualReviewCapture | null | undefined,
  poseEpsilon = DEFAULT_POSE_EPSILON,
): VisualReviewReceipt {
  const sourceHash = hasValidPixels(source) ? hashRgba(source) : null
  const bakedHash = hasValidPixels(baked) ? hashRgba(baked) : null
  const unknown: VisualReviewReceipt = {
    status: 'unknown',
    mismatchRatio: null,
    sourceHash,
    bakedHash,
  }

  if (
    !hasValidPixels(source) ||
    !hasValidPixels(baked) ||
    source.width !== baked.width ||
    source.height !== baked.height ||
    !hasValidPose(source.cameraPose) ||
    !hasValidPose(baked.cameraPose) ||
    !Number.isFinite(poseEpsilon) ||
    poseEpsilon < 0 ||
    !hasMatchingPose(source.cameraPose, baked.cameraPose, poseEpsilon)
  ) {
    return unknown
  }

  let mismatches = 0
  const pixelCount = source.width * source.height
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    let changed = false
    for (let channel = 0; channel < 4; channel++) {
      const sourceByte = source.rgba[pixel * 4 + channel]
      const bakedByte = baked.rgba[pixel * 4 + channel]
      if (sourceByte === undefined || bakedByte === undefined) return unknown
      if (sourceByte !== bakedByte) changed = true
    }
    if (changed) mismatches++
  }

  return {
    status: mismatches === 0 ? 'pass' : 'fail',
    mismatchRatio: mismatches / pixelCount,
    sourceHash,
    bakedHash,
  }
}
