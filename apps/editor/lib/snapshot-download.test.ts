import { expect, spyOn, test } from 'bun:test'
import { emitter, type SnapshotSavedEvent } from '@pascal-app/core'
import type { EditorProps } from '@pascal-app/editor'
import { createSceneThumbnailCapture } from './scene-thumbnail-capture'
import { downloadSnapshot } from './snapshot-download'

const camera = {
  requestId: 'shutter-1',
  position: [1, 2, 3] as [number, number, number],
  target: null,
  captureMode: 'standard' as const,
  resolution: { w: 1920, h: 1080 },
}

test('a snapshot downloads its captured blob before acknowledging the exact shutter request', async () => {
  const saved: Array<SnapshotSavedEvent | undefined> = []
  const onSaved = (event: SnapshotSavedEvent | undefined) => saved.push(event)
  emitter.on('snapshot:saved', onSaved)
  const blob = new Blob(['captured pixels'], { type: 'image/webp' })
  let complete!: (url: string) => void
  try {
    const pending = downloadSnapshot(
      'project',
      'My house / kitchen',
      blob,
      camera,
      (image, name) => {
        expect(image).toBe(blob)
        expect(name).toMatch(/^My-house-kitchen-snapshot-.*\.webp$/)
        return new Promise((resolve) => {
          complete = resolve
        })
      },
    )
    expect(saved).toEqual([])
    complete('blob:download')
    await pending
    expect(saved).toEqual([
      {
        id: 'shutter-1',
        requestId: 'shutter-1',
        projectId: 'project',
        url: 'blob:download',
        width: 1920,
        height: 1080,
      },
    ])
  } finally {
    emitter.off('snapshot:saved', onSaved)
  }
})

test('a failed download rejects without reporting that the snapshot was saved', async () => {
  const saved: Array<SnapshotSavedEvent | undefined> = []
  const onSaved = (event: SnapshotSavedEvent | undefined) => saved.push(event)
  emitter.on('snapshot:saved', onSaved)
  try {
    await expect(
      downloadSnapshot('project', 'House', new Blob(), camera, () => {
        throw new Error('Download unavailable')
      }),
    ).rejects.toThrow('Download unavailable')
    expect(saved).toEqual([])
  } finally {
    emitter.off('snapshot:saved', onSaved)
  }
})

test('PNG captures download with the correct extension and portrait dimensions', async () => {
  const blob = new Blob(['portrait pixels'], { type: 'image/png' })
  await downloadSnapshot(
    'project',
    '',
    blob,
    { ...camera, resolution: { w: 1080, h: 1920 } },
    (_, name) => {
      expect(name).toMatch(/^Pascal-snapshot-.*\.png$/)
      return 'blob:portrait'
    },
  )
})

test('the browser download URL stays usable for 60 seconds, then is revoked', async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimer = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')
  const timers: Array<{ run: () => void; delay: number }> = []
  let clicked = false
  let removed = false
  const anchor = {
    href: '',
    download: '',
    click: () => {
      clicked = true
    },
    remove: () => {
      removed = true
    },
  }
  const created = spyOn(URL, 'createObjectURL').mockReturnValue('blob:browser-download')
  const revoked = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => anchor,
      body: { appendChild: () => {} },
    },
  })
  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    value: (run: () => void, delay: number) => {
      timers.push({ run, delay })
      return 0
    },
  })
  try {
    await downloadSnapshot('project', 'Room', new Blob(['pixels'], { type: 'image/webp' }), camera)
    expect(clicked).toBe(true)
    expect(removed).toBe(true)
    expect(anchor.href).toBe('blob:browser-download')
    expect(revoked).not.toHaveBeenCalled()
    expect(timers.map(({ delay }) => delay)).toEqual([60_000])
    timers[0].run()
    expect(revoked).toHaveBeenCalledWith('blob:browser-download')
  } finally {
    created.mockRestore()
    revoked.mockRestore()
    for (const [key, descriptor] of [
      ['document', previousDocument],
      ['setTimeout', previousTimer],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('overlapping manual downloads acknowledge only the completed shutter', async () => {
  const saved: SnapshotSavedEvent[] = []
  const onSaved = (event: SnapshotSavedEvent | undefined) => {
    if (event) saved.push(event)
  }
  emitter.on('snapshot:saved', onSaved)
  let complete!: (url: string) => void
  try {
    const first = downloadSnapshot(
      'project',
      'Building',
      new Blob(['first frame'], { type: 'image/webp' }),
      { ...camera, requestId: 'manual-first' },
      () =>
        new Promise<string>((resolve) => {
          complete = resolve
        }),
    )
    await expect(
      downloadSnapshot(
        'project',
        'Building',
        new Blob(['second frame'], { type: 'image/webp' }),
        { ...camera, requestId: 'manual-failed' },
        () => Promise.reject(new Error('Download blocked')),
      ),
    ).rejects.toThrow('Download blocked')
    expect(saved).toEqual([])

    complete('blob:manual-first')
    await first
    expect(saved).toEqual([
      {
        id: 'manual-first',
        requestId: 'manual-first',
        projectId: 'project',
        url: 'blob:manual-first',
        width: 1920,
        height: 1080,
      },
    ])
  } finally {
    emitter.off('snapshot:saved', onSaved)
  }
})

test('an embedded Editor host acknowledges only a completed manual request', async () => {
  const saved: SnapshotSavedEvent[] = []
  const onSaved = (event: SnapshotSavedEvent | undefined) => {
    if (event) saved.push(event)
  }
  emitter.on('snapshot:saved', onSaved)

  const uploaded: Array<{ sceneId: string; blob: Blob }> = []
  const downloaded: Array<{ blob: Blob; filename: string; requestId?: string }> = []
  const background = new Blob(['thumbnail'], { type: 'image/webp' })
  const frame = new Blob(['manual frame'], { type: 'image/webp' })
  let finish!: (url: string) => void
  const now = () => new Date('2026-01-02T03:04:05.000Z')

  const onThumbnailCapture: NonNullable<EditorProps['onThumbnailCapture']> =
    createSceneThumbnailCapture(
      { id: 'scene', name: 'Demo / Model', projectId: 'embedded-project' },
      {
        upload: async (sceneId, blob) => {
          uploaded.push({ sceneId, blob })
        },
        download: (projectId, projectName, blob, cameraData) =>
          downloadSnapshot(
            projectId,
            projectName,
            blob,
            cameraData,
            (payload, filename) => {
              downloaded.push({ blob: payload, filename, requestId: cameraData.requestId })
              if (cameraData.requestId === 'manual-failed') {
                throw new Error('Download unavailable')
              }
              return new Promise<string>((resolve) => {
                finish = resolve
              })
            },
            now,
          ),
      },
    )

  try {
    await onThumbnailCapture(background, {
      ...camera,
      captureMode: undefined,
      requestId: undefined,
    })
    await onThumbnailCapture(background, {
      ...camera,
      captureMode: undefined,
      requestId: 'background-stale',
    })
    expect(uploaded).toEqual([{ sceneId: 'scene', blob: background }])
    expect(downloaded).toEqual([])
    expect(saved).toEqual([])

    const pending = Promise.resolve(
      onThumbnailCapture(frame, { ...camera, requestId: 'manual-success' }),
    )
    await expect(
      Promise.resolve(onThumbnailCapture(frame, { ...camera, requestId: 'manual-failed' })),
    ).rejects.toThrow('Download unavailable')
    expect(saved).toEqual([])
    expect(uploaded).toHaveLength(1)
    expect(downloaded).toEqual([
      {
        blob: frame,
        filename: 'Demo-Model-snapshot-2026-01-02T03-04-05-000Z.webp',
        requestId: 'manual-success',
      },
      {
        blob: frame,
        filename: 'Demo-Model-snapshot-2026-01-02T03-04-05-000Z.webp',
        requestId: 'manual-failed',
      },
    ])

    finish('blob:manual-success')
    await pending
    expect(saved).toEqual([
      {
        id: 'manual-success',
        requestId: 'manual-success',
        projectId: 'embedded-project',
        url: 'blob:manual-success',
        width: 1920,
        height: 1080,
      },
    ])
  } finally {
    emitter.off('snapshot:saved', onSaved)
  }
})
