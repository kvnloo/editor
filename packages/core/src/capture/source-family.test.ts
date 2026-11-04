import { describe, expect, test } from 'bun:test'
import {
  type CaptureArtifactReference,
  normalizeCaptureSessionManifest,
  verifySourceFamily,
} from './index'

const MASTER_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const DERIVED_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const OTHER_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const master: CaptureArtifactReference = {
  id: 'master-render',
  mediaType: 'image/png',
  sha256: MASTER_SHA,
}

function derived(id: string, sourceMasterSha256: unknown): CaptureArtifactReference {
  return {
    id,
    mediaType: 'image/webp',
    sha256: DERIVED_SHA,
    metadata: { sourceMasterSha256 },
  }
}

describe('verifySourceFamily', () => {
  test('passes for pyramid, preview and tiles naming the master digest', () => {
    expect(
      verifySourceFamily(master, [
        derived('pyramid', MASTER_SHA),
        derived('preview', MASTER_SHA.toUpperCase()),
        derived('tile-0', MASTER_SHA),
      ]),
    ).toBe('pass')
  })

  test('fails when any derived artifact names a different master', () => {
    expect(
      verifySourceFamily(master, [derived('preview', MASTER_SHA), derived('tile-0', OTHER_SHA)]),
    ).toBe('fail')
  })

  test('a mismatch wins over missing legacy metadata', () => {
    expect(
      verifySourceFamily(master, [
        { id: 'legacy-tile', mediaType: 'image/webp' },
        derived('wrong-preview', OTHER_SHA),
      ]),
    ).toBe('fail')
  })

  test('missing metadata or sourceMasterSha256 is unknown, never pass', () => {
    expect(
      verifySourceFamily(master, [{ id: 'legacy-preview', mediaType: 'image/webp' }]),
    ).toBe('unknown')
    expect(
      verifySourceFamily(master, [
        { id: 'legacy-tile', mediaType: 'image/webp', metadata: {} },
      ]),
    ).toBe('unknown')
    expect(verifySourceFamily(master, [derived('preview', MASTER_SHA), {
      id: 'legacy-tile',
      mediaType: 'image/webp',
    }])).toBe('unknown')
  })

  test('a missing master digest or an empty derived set is unknown', () => {
    expect(
      verifySourceFamily({ id: 'master', mediaType: 'image/png' }, [
        derived('preview', MASTER_SHA),
      ]),
    ).toBe('unknown')
    expect(verifySourceFamily(master, [])).toBe('unknown')
  })

  test('throws for malformed master, derived or declared source digests', () => {
    expect(() => verifySourceFamily({ ...master, sha256: 'short' }, [
      derived('preview', MASTER_SHA),
    ])).toThrow('SHA-256')
    expect(() => verifySourceFamily(master, [{
      ...derived('preview', MASTER_SHA),
      sha256: 'not-hex',
    }])).toThrow('SHA-256')
    expect(() => verifySourceFamily(master, [derived('preview', 'f'.repeat(63))])).toThrow(
      'SHA-256',
    )
    expect(() => verifySourceFamily(master, [derived('preview', 12)])).toThrow('SHA-256')
    expect(() =>
      verifySourceFamily(master, [
        derived('mismatch', OTHER_SHA),
        derived('malformed', 'invalid'),
      ]),
    ).toThrow('SHA-256')
  })

  test('v1 and v2 manifests without source-family metadata still load', () => {
    const v1 = normalizeCaptureSessionManifest({
      schemaVersion: 1,
      sessionId: 'legacy-v1',
      projectId: 'project',
      streams: {
        roomModel: {
          kind: 'room-model',
          mediaType: 'model/vnd.usdz+zip',
          url: 'https://example.com/room.usdz',
        },
      },
    })
    expect(v1.streams[0]?.artifact?.uri).toBe('https://example.com/room.usdz')
    expect(v1.streams[0]?.artifact?.metadata).toBeUndefined()

    const v2 = normalizeCaptureSessionManifest({
      schemaVersion: 2,
      sessionId: 'legacy-v2',
      streams: [
        {
          id: 'preview',
          kind: 'preview-image',
          artifact: { id: 'preview', mediaType: 'image/webp', sha256: DERIVED_SHA },
        },
      ],
    })
    const legacyArtifact = v2.streams[0]?.artifact
    expect(legacyArtifact?.metadata).toBeUndefined()
    if (!legacyArtifact) throw new Error('Expected the v2 preview artifact.')
    expect(verifySourceFamily(master, [legacyArtifact])).toBe('unknown')
  })
})
