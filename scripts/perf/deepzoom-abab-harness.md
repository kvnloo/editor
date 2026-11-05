# OpenSeadragon ABAB development harness

Run `bun run perf:deepzoom-harness` after `bun install`. The server binds to
`127.0.0.1:4317`, outside the Next.js route tree and production bundles.
An optional `DEEPZOOM_HARNESS_PORT` changes its port.

Set **both** query parameters on the harness URL:

- `dzi`: the complete HTTP(S) signed DZI descriptor URL, including its token.
- `tapeSource`: the **exact same** `sourceUrl` from the #25 input tape.

Percent-encode each full URL as a query parameter. A missing/mismatched
descriptor is rejected before mounting the viewer. The bridge becomes available
as `window.__deepzoomAbab` only after the #16 OpenSeadragon 5.0.1 instance
is created. Its `sourceUrl`, `viewer` (and v5 viewer `tile-loaded` /
per-TiledImage `fully-loaded-change` events), and `applyViewportStep` are
consumed by #28's collector. `onTileLoaded` and `onFullyLoadedChange`
return unsubscribe functions for manual dev probes.

The #28 collector divides #25's device-pixel tape by browser DPR before
calling `applyViewportStep({ zoom, panX, panY })`. The bridge converts those
CSS-pixel deltas to OpenSeadragon image-width viewport units using the actual
container bounds, current zoom and DPR, without a second DPR division.

Use the resulting harness URL for the OpenSeadragon arm. A different A/B
implementation needs its **own** page and bridge; using this URL for both arms
is a self-comparison, not a performance win. Cross-origin DZI/tile fetching
requires the descriptor host to allow the browser origin. The server does not
proxy or log signed URLs. Cache condition and GPU identity remain unverified
by this harness; #28 reports them conservatively.
