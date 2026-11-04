import { createHash } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/server'
import { getCaptureEvidenceTool } from '@pascal-app/core/agent-tools'
import {
  type CaptureSource,
  type CaptureSourceResolver,
  type CaptureStreamDescriptor,
  createHttpCaptureSource,
} from '@pascal-app/core/capture'
import type { AnyNodeId } from '@pascal-app/core/schema'
import { z } from 'zod'
import type { SceneOperations } from '../operations'
import { READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS } from './annotations'

const verdictSchema = z.enum(['pass', 'fail', 'unknown'])
type Verdict = z.infer<typeof verdictSchema>

const streamEvidenceSchema = z.object({
  streamId: z.string(),
  kind: z.string(),
  availability: z.enum(['pending', 'live', 'ready', 'failed']),
  artifactId: z.string().nullable(),
  presence: verdictSchema,
  digest: verdictSchema,
  producer: z.literal('unknown'),
  verdict: verdictSchema,
  reason: z.string(),
})

export const getCaptureEvidenceOutput = z.object({
  nodeId: z.string(),
  sessionId: z.string().nullable(),
  schemaVersion: z.number().nullable(),
  state: z.enum(['live', 'finalizing', 'ready', 'failed']).nullable(),
  verdict: verdictSchema,
  reason: z.string(),
  streams: z.array(streamEvidenceSchema),
})

type Evidence = z.infer<typeof getCaptureEvidenceOutput>
type StreamEvidence = Evidence['streams'][number]

export type CaptureEvidenceHosts = {
  /** A trusted host may resolve authenticated, local, or live capture sessions. */
  captureSourceResolver?: CaptureSourceResolver
  /** Artifact bytes must be read through the host's access policy when one is provided. */
  captureArtifactFetch?: typeof globalThis.fetch
}

function unknownStream(stream: CaptureStreamDescriptor, reason: string): StreamEvidence {
  return {
    streamId: stream.id,
    kind: stream.kind,
    availability: stream.availability,
    artifactId: stream.artifact?.id ?? null,
    presence: 'unknown',
    digest: 'unknown',
    producer: 'unknown',
    verdict: 'unknown',
    reason,
  }
}

function unknownSession(nodeId: string, sessionId: string | null, reason: string): Evidence {
  return {
    nodeId,
    sessionId,
    schemaVersion: null,
    state: null,
    verdict: 'unknown',
    reason,
    streams: [],
  }
}

async function inspectStream(
  stream: CaptureStreamDescriptor,
  source: CaptureSource,
  fetchArtifact: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<StreamEvidence> {
  const artifact = stream.artifact
  if (!artifact) {
    return unknownStream(stream, stream.inline === undefined ? 'artifact_missing' : 'inline_only')
  }
  if (!source.resolveArtifact) return unknownStream(stream, 'artifact_resolver_unavailable')

  let resolved: Awaited<ReturnType<NonNullable<CaptureSource['resolveArtifact']>>> | undefined
  try {
    resolved = await source.resolveArtifact(artifact, signal)
    if (!resolved.url) return unknownStream(stream, 'artifact_uri_unavailable')

    // A declared checksum is a claim to check, not proof of who produced the bytes.
    const expected = artifact.sha256?.toLowerCase()
    const verifiable = expected !== undefined && /^[a-f0-9]{64}$/.test(expected)
    const response = await fetchArtifact(resolved.url, {
      method: verifiable ? 'GET' : 'HEAD',
      signal,
    })
    if (response.status !== 200) return unknownStream(stream, 'artifact_unavailable')

    const evidence = unknownStream(stream, verifiable ? 'producer_unverified' : 'digest_unavailable')
    if (!verifiable) {
      evidence.presence = 'pass'
      return evidence
    }

    const reader = response.body?.getReader()
    if (!reader) return unknownStream(stream, 'artifact_bytes_unavailable')
    const hash = createHash('sha256')
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        bytes += value.byteLength
      }
    } finally {
      reader.releaseLock()
    }

    evidence.presence = 'pass'
    if (artifact.byteLength !== undefined && artifact.byteLength !== bytes) {
      evidence.digest = 'fail'
      evidence.verdict = 'fail'
      evidence.reason = 'artifact_byte_length_mismatch'
      return evidence
    }
    evidence.digest = hash.digest('hex') === expected ? 'pass' : 'fail'
    evidence.verdict = evidence.digest === 'fail' ? 'fail' : 'unknown'
    evidence.reason = evidence.digest === 'fail' ? 'sha256_mismatch' : 'producer_unverified'
    return evidence
  } catch {
    return unknownStream(stream, 'artifact_unverifiable')
  } finally {
    resolved?.dispose?.()
  }
}

export function registerGetCaptureEvidence(
  server: McpServer,
  operations: SceneOperations,
  { captureSourceResolver, captureArtifactFetch }: CaptureEvidenceHosts = {},
): void {
  server.registerTool(
    getCaptureEvidenceTool.name,
    {
      title: getCaptureEvidenceTool.title,
      description: getCaptureEvidenceTool.description,
      inputSchema: z.object(getCaptureEvidenceTool.input).strict(),
      outputSchema: getCaptureEvidenceOutput,
      annotations: READ_ONLY_OPEN_WORLD_TOOL_ANNOTATIONS,
    },
    async ({ id }, context) => {
      const node = operations.getNode(id as AnyNodeId)
      if (!node || node.type !== 'scan') {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ code: 'scan_not_found', error: 'Scan node not found: ' + id }),
            },
          ],
        }
      }

      const locator = node.captureSession
      let payload: Evidence
      if (!locator) {
        payload = unknownSession(id, null, 'capture_session_missing')
      } else {
        try {
          const source = captureSourceResolver
            ? await captureSourceResolver(locator)
            : createHttpCaptureSource(locator)
          const descriptor = await source.describe(context.mcpReq.signal)
          if (
            descriptor.sessionId !== locator.sessionId ||
            (locator.schemaVersion !== undefined &&
              descriptor.schemaVersion !== locator.schemaVersion) ||
            (locator.revisionId !== undefined && descriptor.revisionId !== locator.revisionId)
          ) {
            payload = unknownSession(id, locator.sessionId, 'capture_manifest_identity_mismatch')
          } else {
            const streams: StreamEvidence[] = []
            for (const stream of descriptor.streams) {
              streams.push(
                await inspectStream(
                  stream,
                  source,
                  captureArtifactFetch ?? globalThis.fetch,
                  context.mcpReq.signal,
                ),
              )
            }
            payload = {
              nodeId: id,
              sessionId: descriptor.sessionId,
              schemaVersion: descriptor.schemaVersion,
              state: descriptor.state,
              verdict: streams.some((stream) => stream.verdict === 'fail') ? 'fail' : 'unknown',
              reason: streams.some((stream) => stream.verdict === 'fail')
                ? 'artifact_integrity_failed'
                : 'producer_unverified',
              streams,
            }
          }
        } catch {
          payload = unknownSession(id, locator.sessionId, 'capture_source_unavailable')
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}
