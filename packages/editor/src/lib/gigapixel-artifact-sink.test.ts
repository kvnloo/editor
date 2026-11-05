import { describe, expect, test } from 'bun:test'
import {
  createInMemoryGigapixelArtifactSink,
  createWritableGigapixelArtifactSink,
} from '@pascal-app/editor/gigapixel-artifact-sink'

describe('gigapixel artifact sinks', () => {
  test('hashes consecutive chunks without loading a committed file', async () => {
    const written: Uint8Array[] = []
    let closed = 0
    let aborted = 0
    const sink = createWritableGigapixelArtifactSink(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          written.push(chunk.slice())
        },
        close() {
          closed += 1
        },
        abort() {
          aborted += 1
        },
      }),
    )
    await sink.write({ kind: 'zip-chunk', bytes: new TextEncoder().encode('a') })
    await sink.write({ kind: 'tile' })
    await sink.write({ kind: 'zip-chunk', bytes: new TextEncoder().encode('bc') })
    const result = await sink.finish()

    expect(result).toEqual({
      bytes: 3,
      tileCount: 1,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
    expect(new TextDecoder().decode(new Uint8Array(written.flatMap((part) => [...part])))).toBe(
      'abc',
    )
    expect(closed).toBe(1)
    expect(aborted).toBe(0)
    await sink.abort()
    expect(aborted).toBe(0)
    await expect(sink.write({ kind: 'tile' })).rejects.toThrow('no longer open')
  })

  test('an aborted memory artifact cannot publish a partial Blob', async () => {
    const sink = createInMemoryGigapixelArtifactSink()
    await sink.write({ kind: 'zip-chunk', bytes: Uint8Array.of(1, 2, 3) })
    await sink.abort()
    await sink.abort()
    expect(() => sink.blob()).toThrow('has not been committed')
    await expect(sink.finish()).rejects.toThrow('no longer open')
  })

  test('writable abort does not close an unfinished file', async () => {
    let aborted = 0
    let closed = 0
    const sink = createWritableGigapixelArtifactSink(
      new WritableStream<Uint8Array>({
        write() {},
        close() {
          closed += 1
        },
        abort() {
          aborted += 1
        },
      }),
    )
    await sink.write({ kind: 'zip-chunk', bytes: Uint8Array.of(1) })
    await sink.abort()
    await sink.abort()
    expect(aborted).toBe(1)
    expect(closed).toBe(0)
  })
})
