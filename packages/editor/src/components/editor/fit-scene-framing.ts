export type FitSceneBounds = {
  center: [number, number]
  size: [number, number]
} | null

export type FitSceneLookAt = {
  eyeX: number
  eyeY: number
  eyeZ: number
  targetX: number
  targetY: number
  targetZ: number
}

export type PendingFitScene = {
  bounds: FitSceneBounds
}

export type FitSceneEventPlan =
  | { action: 'ignore' }
  | { action: 'apply'; lookAt: FitSceneLookAt }
  | { action: 'queue'; pending: PendingFitScene }

export type FitSceneResumePlan = { action: 'noop' } | { action: 'apply'; lookAt: FitSceneLookAt }

/**
 * Compute the orbit look-at used by `camera-controls:fit-scene`.
 * Null bounds restore the empty-editor default pose.
 */
export function computeFitSceneLookAt(bounds: FitSceneBounds): FitSceneLookAt {
  if (!bounds) {
    return {
      eyeX: 20,
      eyeY: 20,
      eyeZ: 20,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
    }
  }

  const [cx, cz] = bounds.center
  const [w, d] = bounds.size
  // Use the longer horizontal extent to size the orbit radius so the whole
  // footprint sits in view regardless of aspect ratio.
  const maxExtent = Math.max(w, d)
  const distance = Math.max(maxExtent * 1.4, 15)
  const height = Math.max(maxExtent * 0.8, 10)
  return {
    eyeX: cx + distance * 0.7,
    eyeY: height,
    eyeZ: cz + distance * 0.7,
    targetX: cx,
    targetY: 0,
    targetZ: cz,
  }
}

/**
 * Decide what to do when a fit-scene event arrives.
 * First-person (and briefly-unmounted orbit controls) must queue the frame
 * so it can apply once orbit is back.
 */
export function planFitSceneOnEvent(input: {
  isPreviewMode: boolean
  isFirstPersonMode: boolean
  hasControls: boolean
  bounds: FitSceneBounds
}): FitSceneEventPlan {
  if (input.isPreviewMode) return { action: 'ignore' }

  const pending: PendingFitScene = { bounds: input.bounds }
  if (input.isFirstPersonMode || !input.hasControls) {
    return { action: 'queue', pending }
  }

  return { action: 'apply', lookAt: computeFitSceneLookAt(input.bounds) }
}

/**
 * Flush a queued load frame once orbit controls can apply it.
 */
export function planFitSceneOnOrbitResume(input: {
  isPreviewMode: boolean
  isFirstPersonMode: boolean
  hasControls: boolean
  pending: PendingFitScene | null
}): FitSceneResumePlan {
  if (!input.pending || input.isPreviewMode || input.isFirstPersonMode || !input.hasControls) {
    return { action: 'noop' }
  }

  return { action: 'apply', lookAt: computeFitSceneLookAt(input.pending.bounds) }
}
/**
 * Keep the newest scene fit until the orbit camera-controls ref is attached.
 * Ref attachment, not a one-shot frame, is the retry trigger. The frame
 * deferral lets the first-person pose restore complete before fitting.
 */
export function createFitSceneControlsCoordinator({
  getMode,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
}: {
  getMode: () => { isPreviewMode: boolean; isFirstPersonMode: boolean }
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (frame: number) => void
}) {
  type Controls = {
    setLookAt: (
      eyeX: number,
      eyeY: number,
      eyeZ: number,
      targetX: number,
      targetY: number,
      targetZ: number,
      enableTransition: boolean,
    ) => unknown
  }
  let controls: Controls | null = null
  let pending: PendingFitScene | null = null
  let frame: number | null = null
  let disposed = false

  const cancelScheduledFrame = () => {
    if (frame === null) return
    cancelFrame(frame)
    frame = null
  }

  const applyLookAt = (control: Controls, lookAt: FitSceneLookAt) => {
    control.setLookAt(
      lookAt.eyeX,
      lookAt.eyeY,
      lookAt.eyeZ,
      lookAt.targetX,
      lookAt.targetY,
      lookAt.targetZ,
      true,
    )
  }

  const applyPending = () => {
    if (disposed || !controls || !pending) return
    const plan = planFitSceneOnOrbitResume({
      ...getMode(),
      hasControls: true,
      pending,
    })
    if (plan.action !== 'apply') return
    pending = null
    applyLookAt(controls, plan.lookAt)
  }

  const schedule = () => {
    if (disposed || !pending || frame !== null) return
    frame = requestFrame(() => {
      frame = null
      applyPending()
    })
  }

  const onFitScene = (bounds: FitSceneBounds) => {
    if (disposed) return
    const mode = getMode()
    const plan = planFitSceneOnEvent({ ...mode, hasControls: !!controls, bounds })
    if (plan.action === 'ignore') return
    cancelScheduledFrame()
    if (plan.action === 'queue') {
      pending = plan.pending
      if (!mode.isFirstPersonMode) schedule()
      return
    }
    pending = null
    if (controls) applyLookAt(controls, plan.lookAt)
  }

  const attachControls = (next: Controls | null) => {
    if (disposed) return
    controls = next
    if (next) schedule()
    else cancelScheduledFrame()
  }

  const onOrbitResume = () => {
    cancelScheduledFrame()
    const mode = getMode()
    if (!mode.isFirstPersonMode && !mode.isPreviewMode) schedule()
  }

  const dispose = () => {
    disposed = true
    cancelScheduledFrame()
    controls = null
    pending = null
  }

  return { onFitScene, attachControls, onOrbitResume, dispose }
}
