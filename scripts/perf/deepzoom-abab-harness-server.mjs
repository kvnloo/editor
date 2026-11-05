import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.NODE_ENV === 'production') {
  throw new Error('The DeepZoom ABAB harness is development-only')
}

const directory = dirname(fileURLToPath(import.meta.url))
const built = await Bun.build({
  entrypoints: [join(directory, 'deepzoom-abab-harness-client.ts')],
  target: 'browser',
  format: 'esm',
  splitting: true,
  minify: false,
  sourcemap: 'none',
})
if (!built.success) {
  throw new Error('Could not build the DeepZoom ABAB development harness')
}

const files = new Map(built.outputs.map((asset) => [basename(asset.path), asset]))
const entry = built.outputs.find((asset) => asset.kind === 'entry-point')
if (!entry) throw new Error('DeepZoom harness build emitted no entry point')

const port = Number(process.env.DEEPZOOM_HARNESS_PORT ?? '4317')
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new TypeError('DEEPZOOM_HARNESS_PORT must be a valid TCP port')
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepZoom ABAB development harness</title>
  <style>
    html, body, #root { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    .h-full { height: 100%; }
    .w-full { width: 100%; }
    #status { position: fixed; z-index: 100; top: 8px; left: 8px; color: #b91c1c; }
  </style>
</head>
<body>
  <div id="root"></div><div id="status" role="alert"></div>
  <script type="module" src="/assets/${basename(entry.path)}"></script>
</body>
</html>`

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    if (pathname.startsWith('/assets/')) {
      const filename = pathname.slice('/assets/'.length)
      const asset = filename.includes('/') ? null : files.get(filename)
      if (asset) {
        const mime = filename.endsWith('.css')
          ? 'text/css'
          : filename.endsWith('.js')
            ? 'application/javascript'
            : 'application/octet-stream'
        return new Response(asset, {
          headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' },
        })
      }
    }
    return new Response('Not found', { status: 404 })
  },
})
console.log('DeepZoom ABAB development harness: http://127.0.0.1:' + port)
