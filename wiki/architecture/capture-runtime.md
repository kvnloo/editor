# Capture runtime

Capture data is an optional viewer extension, not a private Community renderer and not a second
scene graph.

## Ownership boundaries

- `@pascal-app/core/capture` (`packages/core/src/capture/`) owns versioned manifests, normalized
  stream descriptors, stable session locators, incremental packet headers, and the `CaptureSource`
  interface. It has no React, Three.js, authentication, database, or prescribed transport, so it
  stays inside core's pure-logic layer rule.
- `@pascal-app/viewer/capture` (`packages/viewer/src/capture/`) mounts inside `Viewer` through its
  existing children slot. It resolves `scan.captureSession`, portals layers into that scan node's
  registered group, honors per-layer visibility, composes declared local-to-parent coordinate frames
  into session space, and supplies reference model, device-motion, point-cloud, and compact
  color-surface renderers. `@pascal-app/viewer/capture/preview` exposes the matcap and surface-mesh
  geometry builders on their own for capture clients that render a local preview without the runtime.
- `@pascal-app/core` stores only the scene anchor: session locator, optional current mesh URL,
  placement, opacity, and an extensible visibility map. Raw samples and artifact inventories never
  enter scene JSON.
- A host owns source resolution, access control, signed URLs, persistence, retention, collaboration,
  and transport selection. Community's resolver uses its authenticated capture manifest route.
- The MCP `get_capture_evidence` tool does not follow arbitrary scene-declared HTTP URLs by
  default. A host must supply its capture source resolver (and its policy-checked artifact fetch)
  or list explicit HTTPS origins. The fallback rejects local/file/IP-literal targets and
  cross-origin redirects; manifests are capped at 1 MiB and artifact hashes at 64 MiB by default.
  Host fetch adapters are trusted to enforce their own access control. DNS/private-address
  resolution remains the responsibility of hosts that permit external domains.

## Static and live use the same source

Every source implements `describe()`. Static HTTP sources stop there. Live sources additionally
implement `subscribe()` and yield descriptor changes or bounded stream packets. The runtime applies
generation and sequence ordering before renderers consume packets.

The protocol intentionally does not choose WebSocket, WebRTC, Supabase Realtime, or another
transport. An embedded viewer can use a public HTTP manifest; a local tool can use files or an
in-memory producer; Community can layer its collaboration and authorization model on the same
interface.

Community deliberately does not mount capture artifacts in its public project viewer yet. Its
current manifest route requires edit access; a future public surface needs an explicit view-scoped
artifact and privacy policy before it can use the same runtime safely.

## Stream extension

Manifest v2 streams use stable IDs plus open `kind` and `role` strings. Known roles currently map to
`model`, `deviceMotion`, `pointCloud`, and `surfaceMesh`. The reference surface renderer accepts the
bounded quantized inline preview emitted by Capture; a future UV-textured or server-reconstructed
mesh can be another artifact-backed stream without changing `ScanNode`. Unknown streams remain
available to hosts, which can add a renderer keyed by role or kind without changing the scene
schema. A splat adapter should remain a separate composited renderer while still consuming the same
source and visibility contract.

## Read-only agent evidence

The MCP `get_capture_evidence` tool reads a scan node's `captureSession` through the existing
`CaptureSource.describe()` interface and checks artifact availability and declared SHA-256 byte
digests. Unresolved artifacts, inline-only streams, failed fetches, and absent checksums are
reported as unknown; mismatched bytes are failures. A matching digest is only byte integrity,
not producer authentication: provenance and the overall verdict remain unknown unless a check
fails. No artifact inventory is stored in the scene graph.

## Compatibility

The protocol normalizes Community's v1 RoomPlan/device-motion manifest, so existing captures remain
viewable. `ScanNode` keeps legacy GLB-backed scans loadable, makes `manifestUrl` optional for
host-resolved sessions, and uses an extensible visibility record so adding a data modality does not
require another node-schema release.
