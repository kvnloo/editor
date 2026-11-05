import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
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
  /** A trusted host may fetch authorized artifacts; otherwise origins must be allowlisted. */
  captureArtifactFetch?: typeof globalThis.fetch
  /** Explicit HTTPS origins allowed for scene-declared HTTP manifests and artifact URLs. */
  captureAllowedOrigins?: readonly string[]
  /** Per-artifact digest limit; may be tightened, never raised above 64 MiB. */
  captureMaxArtifactBytes?: number
}

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

class CaptureByteLimitError extends Error {}

function isAllowedCaptureUrl(value: string, origins: readonly string[]): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const hostname = url.hostname.toLowerCase()
  // Reject all IP literals (including mapped/obfuscated forms), not only known private ranges.
  const ipHost =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
  if (
    isIP(ipHost) !== 0 ||
    !hostname.includes('.') ||
    hostname.endsWith('.') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    return false
  }
  return origins.some((origin) => {
    try {
      const allowed = new URL(origin)
      return (
        allowed.protocol === 'https:' &&
        !allowed.username &&
        !allowed.password &&
        allowed.pathname === '/' &&
        !allowed.search &&
        !allowed.hash &&
        allowed.origin === url.origin
      )
    } catch {
      return false
    }
  })
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onChunk: (chunk: Uint8Array) => void,
): Promise<number> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new CaptureByteLimitError('Capture response exceeds byte limit.')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Capture response has no readable body.')
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let complete = false
  let bytes = 0
  try {
    while (true) {
      if (signal.aborted) throw new Error('Capture request was cancelled.')
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error('Capture request was cancelled.')
      if (done) {
        complete = true
        return bytes
      }
      bytes += value.byteLength
      if (bytes > maxBytes) throw new CaptureByteLimitError('Capture response exceeds byte limit.')
      onChunk(value)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function fetchAllowlistedManifest(
  url: string,
  init: RequestInit | undefined,
  allowedOrigins: readonly string[],
  signal: AbortSignal,
): Promise<Response> {
  if (!isAllowedCaptureUrl(url, allowedOrigins) || signal.aborted) {
    throw new Error('Capture manifest request not authorized.')
  }
  // Do not follow a trusted origin's redirect into an untrusted network.
  const response = await globalThis.fetch(url, { ...init, redirect: 'manual', signal })
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('Capture manifest request failed.')
  }
  const chunks: Uint8Array[] = []
  await readCappedBody(response, MAX_MANIFEST_BYTES, signal, (chunk) => chunks.push(chunk))
  return new Response(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'))
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
  fetchArtifact: typeof globalThis.fetch | undefined,
  allowedOrigins: readonly string[],
  maxArtifactBytes: number,
  signal: AbortSignal,
): Promise<StreamEvidence> {
  const artifact = stream.artifact
  if (!artifact) {
    return unknownStream(stream, stream.inline === undefined ? 'artifact_missing' : 'inline_only')
  }
  if (signal.aborted) return unknownStream(stream, 'artifact_cancelled')
  if (!fetchArtifact) return unknownStream(stream, 'artifact_fetch_not_authorized')
  if (!source.resolveArtifact) return unknownStream(stream, 'artifact_resolver_unavailable')

  let resolved: Awaited<ReturnType<NonNullable<CaptureSource['resolveArtifact']>>> | undefined
  try {
    resolved = await source.resolveArtifact(artifact, signal)
    if (!resolved.url) return unknownStream(stream, 'artifact_uri_unavailable')
    if (allowedOrigins.length > 0 && !isAllowedCaptureUrl(resolved.url, allowedOrigins)) {
      return unknownStream(stream, 'artifact_origin_not_allowed')
    }
    if (artifact.byteLength !== undefined && artifact.byteLength > maxArtifactBytes) {
      return unknownStream(stream, 'artifact_byte_limit_exceeded')
    }

    // A declared checksum is a claim to check, not proof of who produced the bytes.
    const expected = artifact.sha256?.toLowerCase()
    const verifiable = expected !== undefined && /^[a-f0-9]{64}$/.test(expected)
    const response = await fetchArtifact(resolved.url, {
      method: verifiable ? 'GET' : 'HEAD',
      signal,
      redirect: 'manual',
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return unknownStream(stream, 'artifact_unavailable')
    }

    const evidence = unknownStream(
      stream,
      verifiable ? 'producer_unverified' : 'digest_unavailable',
    )
    if (!verifiable) {
      await response.body?.cancel().catch(() => undefined)
      evidence.presence = 'pass'
      return evidence
    }

    const hash = createHash('sha256')
    const bytes = await readCappedBody(response, maxArtifactBytes, signal, (chunk) => {
      hash.update(chunk)
    })
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
  } catch (error) {
    if (signal.aborted) return unknownStream(stream, 'artifact_cancelled')
    if (error instanceof CaptureByteLimitError) {
      return unknownStream(stream, 'artifact_byte_limit_exceeded')
    }
    return unknownStream(stream, 'artifact_unverifiable')
  } finally {
    resolved?.dispose?.()
  }
}

export function registerGetCaptureEvidence(
  server: McpServer,
  operations: SceneOperations,
  {
    captureSourceResolver,
    captureArtifactFetch,
    captureAllowedOrigins = [],
    captureMaxArtifactBytes = MAX_ARTIFACT_BYTES,
  }: CaptureEvidenceHosts = {},
): void {
  if (
    !Number.isSafeInteger(captureMaxArtifactBytes) ||
    captureMaxArtifactBytes < 1 ||
    captureMaxArtifactBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('captureMaxArtifactBytes must be between 1 and 67108864.')
  }
  const artifactFetcher =
    captureArtifactFetch ?? (captureAllowedOrigins.length > 0 ? globalThis.fetch : undefined)

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
      } else if (
        !captureSourceResolver &&
        !isAllowedCaptureUrl(locator.manifestUrl ?? '', captureAllowedOrigins)
      ) {
        payload = unknownSession(id, locator.sessionId, 'capture_source_not_authorized')
      } else {
        try {
          const source = captureSourceResolver
            ? await captureSourceResolver(locator)
            : createHttpCaptureSource(locator, {
                fetch: (input, init) =>
                  fetchAllowlistedManifest(
                    String(input),
                    init,
                    captureAllowedOrigins,
                    context.mcpReq.signal,
                  ),
              })
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
              if (context.mcpReq.signal.aborted) break
              streams.push(
                await inspectStream(
                  stream,
                  source,
                  artifactFetcher,
                  captureAllowedOrigins,
                  captureMaxArtifactBytes,
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
        } catch (error) {
          payload = unknownSession(
            id,
            locator.sessionId,
            context.mcpReq.signal.aborted
              ? 'capture_cancelled'
              : error instanceof CaptureByteLimitError
                ? 'capture_manifest_byte_limit_exceeded'
                : 'capture_source_unavailable',
          )
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      }
    },
  )
}
