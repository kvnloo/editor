import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { type DownloadNetwork, isProxyBypassed, resolveProxyUrl } from './http-download.js'
import { uploadVerifiedRuntimeRelease } from './index.js'
import { resolvePascalPaths } from './paths.js'
import { findInstalledRuntime, installBundledRuntime, readActiveRuntime } from './runtime.js'
import {
  ensureWebRuntime,
  fileSha256,
  type RuntimeSource,
  readRuntimeSource,
  verifyArchiveDigest,
  verifyPublishedRuntimeRelease,
} from './runtime-download.js'
import { createRuntimeArchive } from './tar.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('archive digest verification', () => {
  test('accepts a matching digest whatever case it is written in', async () => {
    const fixture = await createFixture()

    await verifyArchiveDigest(fixture.archiveFile, fixture.source.sha256)
    await verifyArchiveDigest(fixture.archiveFile, fixture.source.sha256.toUpperCase())
  })

  test('rejects a changed archive and deletes it when asked to', async () => {
    const fixture = await createFixture()
    const tampered = await tamper(fixture.archiveFile, path.join(fixture.root, 'tampered.tar.gz'))

    await expect(
      verifyArchiveDigest(tampered, fixture.source.sha256, { deleteOnMismatch: true }),
    ).rejects.toMatchObject({
      code: 'runtime_digest_mismatch',
      message: expect.stringContaining(fixture.source.sha256),
    })
    expect(await exists(tampered)).toBe(false)
  })

  test('keeps a caller-supplied archive that fails verification', async () => {
    const fixture = await createFixture()
    const tampered = await tamper(fixture.archiveFile, path.join(fixture.root, 'tampered.tar.gz'))

    await expect(verifyArchiveDigest(tampered, fixture.source.sha256)).rejects.toMatchObject({
      code: 'runtime_digest_mismatch',
    })
    expect(await exists(tampered)).toBe(true)
  })
})

describe('published runtime source', () => {
  test('release recovery rejects new archive bytes for an already-published CLI', async () => {
    const fixture = await createFixture()
    const repacked = await tamper(fixture.archiveFile, path.join(fixture.root, 'repacked.tar.gz'))

    await verifyPublishedRuntimeRelease(fixture.archiveFile, fixture.sourceFile, '1.2.3')
    await expect(
      verifyPublishedRuntimeRelease(repacked, fixture.sourceFile, '1.2.3'),
    ).rejects.toMatchObject({ code: 'runtime_digest_mismatch' })
  })

  test('does not upload a recovery asset before verifying its published pin', async () => {
    const fixture = await createFixture()
    const repacked = await tamper(
      fixture.archiveFile,
      path.join(fixture.root, 'repacked-upload.tar.gz'),
    )
    const uploaded: string[] = []
    const upload = async () => {
      uploaded.push('asset')
    }

    await expect(
      uploadVerifiedRuntimeRelease(repacked, fixture.sourceFile, '1.2.3', upload),
    ).rejects.toMatchObject({ code: 'runtime_digest_mismatch' })
    expect(uploaded).toEqual([])

    await uploadVerifiedRuntimeRelease(fixture.archiveFile, fixture.sourceFile, '1.2.3', upload)
    expect(uploaded).toEqual(['asset'])
  })

  test('reads the archive URL and digest committed with the CLI', async () => {
    const fixture = await createFixture()

    expect(await readRuntimeSource(fixture.sourceFile)).toEqual(fixture.source)
  })

  test.each([
    ['is missing', null],
    ['is not JSON', '{not-json'],
    ['omits the digest', { version: '1.2.3', url: 'https://example.com/a.tar.gz', size: 10 }],
    [
      'carries a truncated digest',
      { version: '1.2.3', url: 'https://example.com/a.tar.gz', sha256: 'abc123', size: 10 },
    ],
    [
      'points at a plain-http URL',
      { version: '1.2.3', url: 'http://example.com/a.tar.gz', sha256: 'a'.repeat(64), size: 10 },
    ],
    [
      'declares an empty archive',
      { version: '1.2.3', url: 'https://example.com/a.tar.gz', sha256: 'a'.repeat(64), size: 0 },
    ],
    [
      'carries a path-like version',
      {
        version: '../escape',
        url: 'https://example.com/a.tar.gz',
        sha256: 'a'.repeat(64),
        size: 10,
      },
    ],
  ])('refuses a runtime source that %s', async (_label, content) => {
    const root = await temporaryRoot()
    const sourceFile = path.join(root, 'runtime-source.json')
    if (content !== null) {
      await writeFile(sourceFile, typeof content === 'string' ? content : JSON.stringify(content))
    }

    await expect(readRuntimeSource(sourceFile)).rejects.toMatchObject({
      code: 'invalid_runtime_source',
      message: expect.stringContaining('--runtime'),
    })
  })
})

describe('web runtime resolution order', () => {
  test('prefers an explicit runtime directory over the environment override', async () => {
    const fixture = await createFixture()
    const other = await fakeRuntimeDirectory(fixture.root, '9.9.9')

    const result = await ensureWebRuntime({
      paths: fixture.paths,
      runtimeSource: fixture.sourceDirectory,
      sourceFile: fixture.sourceFile,
      environment: { PASCAL_BUNDLED_RUNTIME_DIR: other },
    })

    expect(result.runtime.version).toBe('1.2.3')
    expect((await readActiveRuntime(fixture.paths))?.version).toBe('1.2.3')
    expect(await findInstalledRuntime(fixture.paths, '9.9.9')).toBeNull()
  })

  test('falls back to PASCAL_BUNDLED_RUNTIME_DIR when no flag is passed', async () => {
    const fixture = await createFixture()

    const result = await ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: { PASCAL_BUNDLED_RUNTIME_DIR: fixture.sourceDirectory },
    })

    expect(result).toMatchObject({ installed: true, runtime: { version: '1.2.3' } })
  })

  test('installs a local archive that matches the published digest', async () => {
    const fixture = await createFixture()

    const result = await ensureWebRuntime({
      paths: fixture.paths,
      runtimeSource: fixture.archiveFile,
      sourceFile: fixture.sourceFile,
      environment: {},
    })

    expect(result.runtime.directory).toBe(path.join(fixture.paths.runtime, '1.2.3'))
    expect(await exists(path.join(result.runtime.directory, 'apps/editor/server.js'))).toBe(true)
  })

  test('installs nothing when a local archive fails verification', async () => {
    const fixture = await createFixture()
    const tampered = await tamper(fixture.archiveFile, path.join(fixture.root, 'tampered.tar.gz'))

    await expect(
      ensureWebRuntime({
        paths: fixture.paths,
        runtimeSource: tampered,
        sourceFile: fixture.sourceFile,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'runtime_digest_mismatch' })
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).toBeNull()
    expect(await exists(tampered)).toBe(true)
  })

  test('reports a missing runtime path instead of reaching for the network', async () => {
    const fixture = await createFixture()

    await expect(
      ensureWebRuntime({
        paths: fixture.paths,
        runtimeSource: path.join(fixture.root, 'absent.tar.gz'),
        sourceFile: fixture.sourceFile,
        environment: {},
      }),
    ).rejects.toMatchObject({ code: 'runtime_source_missing' })
  })

  test('reuses the installed runtime for this version without downloading', async () => {
    const fixture = await createFixture()
    await installBundledRuntime(fixture.paths, fixture.sourceDirectory, { activate: false })

    const result = await ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
    })

    expect(result).toEqual({
      installed: false,
      runtime: {
        schemaVersion: 1,
        version: '1.2.3',
        directory: path.join(fixture.paths.runtime, '1.2.3'),
      },
    })
    expect((await readActiveRuntime(fixture.paths))?.version).toBe('1.2.3')
  })

  test('installs without activating so an update can health-check first', async () => {
    const fixture = await createFixture()

    const result = await ensureWebRuntime({
      paths: fixture.paths,
      runtimeSource: fixture.sourceDirectory,
      sourceFile: fixture.sourceFile,
      activate: false,
      environment: {},
    })

    expect(result.runtime.version).toBe('1.2.3')
    expect(await readActiveRuntime(fixture.paths)).toBeNull()
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).not.toBeNull()
  })

  test('reports a stalled direct TCP connection without opening a port', async () => {
    const fixture = await createFixture()
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
      downloadTimeoutMs: 500,
      downloadNetwork: network.dependencies,
    }).catch((error: unknown) => error)

    const { protocol, request } = await network.requested
    expect(protocol).toBe('https')
    network.clock.advance(499)
    expect(request.destroyed).toBe(false)
    network.clock.advance(1)

    const failure = await pending
    expect(failure).toMatchObject({ code: 'runtime_download_failed' })
    const message = (failure as Error).message
    expect(message).toContain(fixture.source.url)
    expect(message).toContain(fixture.source.sha256)
    expect(message).toContain('pascal editor --runtime')
    expect(message).toContain('HTTPS_PROXY')
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).toBeNull()
  })

  test('bounds a stalled proxy TCP connection before CONNECT', async () => {
    const fixture = await createFixture()
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: { HTTPS_PROXY: 'http://proxy.example.invalid:3128' },
      downloadTimeoutMs: 500,
      downloadNetwork: network.dependencies,
    }).catch((error: unknown) => error)

    const { protocol, request } = await network.requested
    expect(protocol).toBe('http')
    network.clock.advance(499)
    expect(request.destroyed).toBe(false)
    network.clock.advance(1)

    const failure = await pending
    expect(failure).toMatchObject({ code: 'runtime_download_failed' })
    expect((failure as Error).message).toContain('proxy.example.invalid')
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).toBeNull()
  })

  test('allows a near-deadline direct connect and a later valid archive response', async () => {
    const fixture = await createFixture()
    const archive = await readFile(fixture.archiveFile)
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
      downloadNetwork: network.dependencies,
    })

    const { protocol, request } = await network.requested
    expect(protocol).toBe('https')
    const socket = Object.assign(new EventEmitter(), { connecting: true })
    request.attachSocket(socket)
    network.clock.advance(59_999)
    socket.connecting = false
    socket.emit('connect')
    network.clock.advance(2_000)
    request.emit(
      'response',
      Object.assign(Readable.from([archive]), {
        statusCode: 200,
        headers: { 'content-length': String(archive.length) },
      }) as unknown as IncomingMessage,
    )

    const result = await pending
    expect(result).toMatchObject({ installed: true, runtime: { version: '1.2.3' } })
    expect(request.destroyed).toBe(false)
    expect(network.clock.pendingCount()).toBe(0)
    network.clock.advance(120_001)
    expect(request.destroyed).toBe(false)
    expect(network.clock.pendingCount()).toBe(0)
  })

  test('rejects an otherwise valid direct connect after the 60-second cutoff', async () => {
    const fixture = await createFixture()
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
      downloadNetwork: network.dependencies,
    }).catch((error: unknown) => error)

    const { protocol, request } = await network.requested
    expect(protocol).toBe('https')
    request.attachSocket(Object.assign(new EventEmitter(), { connecting: true }))
    network.clock.advance(60_001)

    expect(request.destroyed).toBe(true)
    expect(await pending).toMatchObject({ code: 'runtime_download_failed' })
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).toBeNull()
  })

  test('accepts a direct connection after 60 seconds with a longer TCP budget', async () => {
    const fixture = await createFixture()
    const archive = await readFile(fixture.archiveFile)
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
      downloadTimeoutMs: 5_000,
      downloadConnectTimeoutMs: 120_000,
      downloadNetwork: network.dependencies,
    })

    const { protocol, request } = await network.requested
    expect(protocol).toBe('https')
    expect(request.inactivityTimeoutMs).toBe(5_000)
    const socket = Object.assign(new EventEmitter(), { connecting: true })
    request.attachSocket(socket)
    network.clock.advance(60_001)
    expect(request.destroyed).toBe(false)
    socket.connecting = false
    socket.emit('connect')
    network.clock.advance(4_999)
    expect(request.destroyed).toBe(false)
    request.emit(
      'response',
      Object.assign(
        Readable.from(
          (async function* () {
            yield archive.subarray(0, 1)
            network.clock.advance(4_999)
            yield archive.subarray(1)
          })(),
        ),
        {
          statusCode: 200,
          headers: { 'content-length': String(archive.length) },
        },
      ) as unknown as IncomingMessage,
    )

    const result = await pending
    expect(result).toMatchObject({ installed: true, runtime: { version: '1.2.3' } })
    expect(request.destroyed).toBe(false)
    expect(network.clock.pendingCount()).toBe(0)
    network.clock.advance(120_001)
    expect(request.destroyed).toBe(false)
    expect(network.clock.pendingCount()).toBe(0)
  })

  test('starts the shorter inactivity budget only after a late TCP connect', async () => {
    const fixture = await createFixture()
    const network = fakeDownloadNetwork()
    const pending = ensureWebRuntime({
      paths: fixture.paths,
      sourceFile: fixture.sourceFile,
      environment: {},
      downloadTimeoutMs: 500,
      downloadConnectTimeoutMs: 120_000,
      downloadNetwork: network.dependencies,
    }).catch((error: unknown) => error)

    const { request } = await network.requested
    expect(request.inactivityTimeoutMs).toBe(500)
    const socket = Object.assign(new EventEmitter(), { connecting: true })
    request.attachSocket(socket)
    network.clock.advance(60_001)
    expect(request.destroyed).toBe(false)
    socket.connecting = false
    socket.emit('connect')
    network.clock.advance(499)
    expect(request.destroyed).toBe(false)
    network.clock.advance(1)

    expect(request.destroyed).toBe(true)
    expect(await pending).toMatchObject({ code: 'runtime_download_failed' })
    expect(await findInstalledRuntime(fixture.paths, '1.2.3')).toBeNull()
  })
})

describe('proxy configuration', () => {
  test('prefers HTTPS_PROXY and trims the configured value', () => {
    const target = new URL('https://github.com/pascalorg/editor')

    expect(resolveProxyUrl(target, { HTTPS_PROXY: ' http://proxy:3128 ' })).toBe(
      'http://proxy:3128',
    )
    expect(resolveProxyUrl(target, { ALL_PROXY: 'http://all:3128' })).toBe('http://all:3128')
    expect(resolveProxyUrl(target, { HTTPS_PROXY: '   ' })).toBeNull()
    expect(resolveProxyUrl(target, {})).toBeNull()
  })

  test('honours NO_PROXY for the download host', () => {
    const target = new URL('https://github.com/pascalorg/editor')

    expect(resolveProxyUrl(target, { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: '*' })).toBeNull()
    expect(
      resolveProxyUrl(target, { HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'github.com' }),
    ).toBeNull()
    expect(
      resolveProxyUrl(target, { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'example.com' }),
    ).toBe('http://proxy:3128')
  })

  test('matches NO_PROXY entries by suffix and ignores ports', () => {
    expect(isProxyBypassed('release-assets.githubusercontent.com', '.githubusercontent.com')).toBe(
      true,
    )
    expect(isProxyBypassed('github.com', 'github.com:443')).toBe(true)
    expect(isProxyBypassed('github.com', '*.github.com')).toBe(true)
    expect(isProxyBypassed('notgithub.com', 'github.com')).toBe(false)
    expect(isProxyBypassed('github.com', '')).toBe(false)
    expect(isProxyBypassed('github.com', undefined)).toBe(false)
  })
})

interface Fixture {
  root: string
  paths: ReturnType<typeof resolvePascalPaths>
  sourceDirectory: string
  archiveFile: string
  sourceFile: string
  source: RuntimeSource
}

/** The downloader tests inject a transport; no DNS, port or wall clock is involved. */
const ARCHIVE_HOST = 'https://downloads.example.invalid'

async function createFixture(version = '1.2.3'): Promise<Fixture> {
  const root = await temporaryRoot()
  const sourceDirectory = await fakeRuntimeDirectory(root, version)
  const archiveFile = path.join(root, `pascal-web-runtime-${version}.tar.gz`)
  await createRuntimeArchive(sourceDirectory, archiveFile)
  const source: RuntimeSource = {
    version,
    url: `${ARCHIVE_HOST}/pascal-web-runtime-${version}.tar.gz`,
    sha256: await fileSha256(archiveFile),
    size: (await stat(archiveFile)).size,
  }
  const sourceFile = path.join(root, 'runtime-source.json')
  await writeFile(sourceFile, JSON.stringify(source))
  return {
    root,
    paths: resolvePascalPaths({ PASCAL_HOME: path.join(root, 'home') }),
    sourceDirectory,
    archiveFile,
    sourceFile,
    source,
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascal-cli-download-test-'))
  roots.push(root)
  return root
}

async function fakeRuntimeDirectory(root: string, version: string): Promise<string> {
  const runtime = path.join(root, `source-${version}`)
  await mkdir(path.join(runtime, 'apps/editor'), { recursive: true })
  await writeFile(
    path.join(runtime, 'runtime-manifest.json'),
    JSON.stringify({ schemaVersion: 2, version, entrypoint: 'apps/editor/server.js' }),
  )
  await writeFile(path.join(runtime, 'apps/editor/server.js'), `// pascal ${version}\n`)
  return runtime
}

async function tamper(archiveFile: string, destination: string): Promise<string> {
  await copyFile(archiveFile, destination)
  const handle = await open(destination, 'r+')
  try {
    const offset = Math.floor((await handle.stat()).size / 2)
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, offset)
    byte[0] = ((byte[0] ?? 0) ^ 0xff) & 0xff
    await handle.write(byte, 0, 1, offset)
  } finally {
    await handle.close()
  }
  return destination
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

type PendingDial = { protocol: 'http' | 'https'; request: InMemoryRequest }

class InMemoryRequest extends EventEmitter {
  destroyed = false
  inactivityTimeoutMs: number | null = null
  private inactivityCallback: (() => void) | null = null
  private cancelInactivity: (() => void) | null = null

  constructor(private readonly clock: ManualClock) {
    super()
    this.on('response', (response: IncomingMessage) => {
      // Subscribe only after the downloader does, or the stream can flow before it is consumed.
      const monitorData = (event: string | symbol) => {
        if (event !== 'data') return
        response.off('newListener', monitorData)
        response.prependListener('data', () => this.restartInactivity())
      }
      const stop = () => {
        response.off('newListener', monitorData)
        this.stopInactivity()
      }
      response.on('newListener', monitorData)
      response.once('end', stop)
      response.once('close', stop)
    })
  }

  setTimeout(timeoutMs: number, callback: () => void): this {
    this.inactivityTimeoutMs = timeoutMs
    this.inactivityCallback = callback
    return this
  }

  attachSocket(socket: EventEmitter & { connecting: boolean }): void {
    this.emit('socket', socket)
    if (socket.connecting) socket.once('connect', () => this.restartInactivity())
    else this.restartInactivity()
  }

  private restartInactivity(): void {
    this.stopInactivity()
    if (this.inactivityCallback && this.inactivityTimeoutMs !== null) {
      this.cancelInactivity = this.clock.schedule(this.inactivityCallback, this.inactivityTimeoutMs)
    }
  }

  private stopInactivity(): void {
    this.cancelInactivity?.()
    this.cancelInactivity = null
  }

  end(): this {
    return this
  }

  destroy(error: Error): this {
    this.stopInactivity()
    this.destroyed = true
    this.emit('error', error)
    return this
  }
}

class ManualClock {
  private now = 0
  private deadlines = new Set<{ due: number; action: () => void }>()

  schedule(action: () => void, delayMs: number): () => void {
    const deadline = { due: this.now + delayMs, action }
    this.deadlines.add(deadline)
    return () => {
      this.deadlines.delete(deadline)
    }
  }

  pendingCount(): number {
    return this.deadlines.size
  }

  advance(ms: number): void {
    this.now += ms
    for (const deadline of this.deadlines) {
      if (deadline.due <= this.now) {
        this.deadlines.delete(deadline)
        deadline.action()
      }
    }
  }
}

function fakeDownloadNetwork(): {
  clock: ManualClock
  requested: Promise<PendingDial>
  dependencies: DownloadNetwork
} {
  const clock = new ManualClock()
  let deliver!: (dial: PendingDial) => void
  const requested = new Promise<PendingDial>((resolve) => {
    deliver = resolve
  })
  const makeRequest = (protocol: PendingDial['protocol']): ClientRequest => {
    const request = new InMemoryRequest(clock)
    deliver({ protocol, request })
    return request as unknown as ClientRequest
  }
  return {
    clock,
    requested,
    dependencies: {
      requestHttp: () => makeRequest('http'),
      requestHttps: () => makeRequest('https'),
      schedule: (action, delayMs) => clock.schedule(action, delayMs),
    },
  }
}
