import { type CaptureArtifactReference, CaptureArtifactReferenceSchema } from './schema'

export type SourceFamilyVerdict = 'pass' | 'fail' | 'unknown'

/** Checks declared digest ancestry, not the artifact bytes or the rendering process. */
export function verifySourceFamily(
  master: CaptureArtifactReference,
  derived: readonly CaptureArtifactReference[],
): SourceFamilyVerdict {
  const masterArtifact = CaptureArtifactReferenceSchema.parse(master)
  const masterDigest = readDigest(masterArtifact.sha256, 'Master artifact sha256')
  let hasMissingEvidence = masterDigest === undefined || derived.length === 0
  let hasMismatch = false

  for (const artifact of derived) {
    const reference = CaptureArtifactReferenceSchema.parse(artifact)
    readDigest(reference.sha256, 'Derived artifact ' + reference.id + ' sha256')
    const sourceDigest = readDigest(
      reference.metadata?.sourceMasterSha256,
      'Derived artifact ' + reference.id + ' metadata.sourceMasterSha256',
    )

    if (sourceDigest === undefined) {
      hasMissingEvidence = true
    } else if (masterDigest !== undefined && sourceDigest !== masterDigest) {
      hasMismatch = true
    }
  }

  if (hasMismatch) return 'fail'
  if (hasMissingEvidence) return 'unknown'
  return 'pass'
}

function readDigest(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(field + ' must be a 64-character SHA-256 hexadecimal digest.')
  }
  return value.toLowerCase()
}
