import { describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createHttpCaptureSource } from '@pascal-app/core/capture'
import { ScanNode } from '@pascal-app/core/schema'
import { SceneBridge } from '../bridge/scene-bridge'
import { createPascalMcpServer } from '../server'

const manifestUrl = 'https://capture.example/sessions/session_1/manifest.json'
const sha256Abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

async function withClient(
  scan: ScanNode,
  manifest: unknown,
  run: (client: Client, bridge: SceneBridge, requested: string[]) => Promise<void>,
): Promise<void> {
  const requested: string[] = []
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    requested.push((init?.method ?? 'GET') + ' ' + url)
    if (url === manifestUrl) return new Response(JSON.stringify(manifest), { status: 200 })
    if (url.endsWith('/ok.bin')) return new Response('abc')
    if (url.endsWith('/tampered.bin')) return new Response('bad')
    if (url.endsWith('/unverified.bin') || url.endsWith('/old.usdz'))
      return new Response(null, { status: 200 })
    return new Response(null, { status: 404 })
  }
  const bridge = new SceneBridge()
  bridge.setScene({ [scan.id]: scan }, [scan.id])
  const server = createPascalMcpServer({
    bridge,
    captureSourceResolver: (locator) => createHttpCaptureSource(locator, { fetch: fetcher }),
    captureArtifactFetch: fetcher,
  })
  const client = new Client({ name: 'capture-evidence-test', version: '0.0.0' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    await run(client, bridge, requested)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('get_capture_evidence', () => {
  test('checks v2 bytes, flags mismatches, and never certifies an unverified producer', async () => {
    const scan = ScanNode.parse({
      id: 'scan_evidence',
      captureSession: {
        sessionId: 'session_1',
        manifestUrl,
        schemaVersion: 2,
        revisionId: 'rev_1',
      },
    })
    const manifest = {
      schemaVersion: 2,
      sessionId: 'session_1',
      revisionId: 'rev_1',
      streams: [
        {
          id: 'verified-bytes',
          kind: 'room-model',
          artifact: {
            id: 'model_ok',
            uri: 'ok.bin',
            mediaType: 'application/octet-stream',
            byteLength: 3,
            sha256: sha256Abc,
          },
        },
        {
          id: 'tampered',
          kind: 'room-model',
          artifact: {
            id: 'model_changed',
            uri: 'tampered.bin',
            mediaType: 'application/octet-stream',
            sha256: sha256Abc,
          },
        },
        {
          id: 'no-digest',
          kind: 'video',
          artifact: {
            id: 'video',
            uri: 'unverified.bin',
            mediaType: 'video/mp4',
          },
        },
        { id: 'missing', kind: 'point-cloud' },
        {
          id: 'not-found',
          kind: 'depth-map',
          artifact: {
            id: 'lost',
            uri: 'lost.bin',
            mediaType: 'application/octet-stream',
            sha256: sha256Abc,
          },
        },
      ],
    }
    await withClient(scan, manifest, async (client, _bridge, requested) => {
      const result = await client.callTool({
        name: 'get_capture_evidence',
        arguments: { id: scan.id },
      })
      expect(result.isError).toBeFalsy()
      const body = result.structuredContent as {
        sessionId: string
        schemaVersion: number
        verdict: string
        streams: Array<{
          streamId: string
          presence: string
          digest: string
          producer: string
          verdict: string
          reason: string
        }>
      }
      expect(body.sessionId).toBe('session_1')
      expect(body.schemaVersion).toBe(2)
      expect(body.verdict).toBe('fail')
      expect(body.streams.map((stream) => stream.streamId)).toEqual([
        'verified-bytes',
        'tampered',
        'no-digest',
        'missing',
        'not-found',
      ])
      expect(body.streams[0]).toMatchObject({
        presence: 'pass',
        digest: 'pass',
        producer: 'unknown',
        verdict: 'unknown',
        reason: 'producer_unverified',
      })
      expect(body.streams[1]).toMatchObject({
        presence: 'pass',
        digest: 'fail',
        verdict: 'fail',
        reason: 'sha256_mismatch',
      })
      expect(body.streams[2]).toMatchObject({
        presence: 'pass',
        digest: 'unknown',
        verdict: 'unknown',
      })
      expect(body.streams[3]).toMatchObject({
        presence: 'unknown',
        digest: 'unknown',
        verdict: 'unknown',
        reason: 'artifact_missing',
      })
      expect(body.streams[4]).toMatchObject({
        presence: 'unknown',
        digest: 'unknown',
        verdict: 'unknown',
        reason: 'artifact_unavailable',
      })
      expect(requested).toContain('GET https://capture.example/sessions/session_1/ok.bin')
      expect(requested).toContain('HEAD https://capture.example/sessions/session_1/unverified.bin')
      expect(
        JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
      ).toEqual(body)
    })
  })

  test('keeps a v1 capture and its scene graph unchanged', async () => {
    const scan = ScanNode.parse({
      id: 'scan_legacy',
      captureSession: {
        sessionId: 'session_1',
        manifestUrl,
        schemaVersion: 1,
      },
    })
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const manifest = {
      schemaVersion: 1,
      sessionId: 'session_1',
      projectId: 'project_legacy',
      streams: {
        roomModel: {
          kind: 'room-model',
          mediaType: 'model/vnd.usdz+zip',
          url: 'https://capture.example/sessions/session_1/old.usdz',
        },
        deviceMotion: {
          kind: 'device-motion',
          trajectory: {
            coordinateSystem: 'arkit-world',
            samples: [
              { segment: 0, timestamp: 0, transform },
              { segment: 0, timestamp: 1, transform },
            ],
          },
        },
      },
    }
    await withClient(scan, manifest, async (client, bridge, requested) => {
      const before = bridge.exportJSON()
      const result = await client.callTool({
        name: 'get_capture_evidence',
        arguments: { id: scan.id },
      })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        sessionId: 'session_1',
        verdict: 'unknown',
        streams: [
          { streamId: 'room-model', presence: 'pass', digest: 'unknown', verdict: 'unknown' },
          { streamId: 'device-motion', presence: 'unknown', digest: 'unknown', verdict: 'unknown' },
        ],
      })
      expect(requested).toContain('HEAD https://capture.example/sessions/session_1/old.usdz')
      expect(bridge.exportJSON()).toEqual(before)
    })
  })

  test('missing capture session and invalid identity remain unknown instead of passing', async () => {
    const scan = ScanNode.parse({ id: 'scan_without_capture' })
    await withClient(scan, {}, async (client) => {
      const result = await client.callTool({
        name: 'get_capture_evidence',
        arguments: { id: scan.id },
      })
      expect(result.structuredContent).toMatchObject({
        nodeId: scan.id,
        sessionId: null,
        verdict: 'unknown',
        reason: 'capture_session_missing',
        streams: [],
      })
      const absent = await client.callTool({
        name: 'get_capture_evidence',
        arguments: { id: 'scan_does_not_exist' },
      })
      expect(absent.isError).toBe(true)
    })

    const linked = ScanNode.parse({
      id: 'scan_mismatched',
      captureSession: { sessionId: 'session_1', manifestUrl, revisionId: 'expected' },
    })
    await withClient(
      linked,
      {
        schemaVersion: 2,
        sessionId: 'session_1',
        revisionId: 'other',
        streams: [{ id: 'not-verified', kind: 'video' }],
      },
      async (client) => {
        const result = await client.callTool({
          name: 'get_capture_evidence',
          arguments: { id: linked.id },
        })
        expect(result.structuredContent).toMatchObject({
          sessionId: 'session_1',
          verdict: 'unknown',
          reason: 'capture_source_unavailable',
          streams: [],
        })
      },
    )
  })
})
