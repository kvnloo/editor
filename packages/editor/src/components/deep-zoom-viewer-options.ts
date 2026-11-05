import { deepZoomTileUrl, parseDeepZoomDescriptor } from '@pascal-app/viewer/capture'

const DEEP_ZOOM_NAMESPACE = 'http://schemas.microsoft.com/deepzoom/2008'

/** Builds a DZI tile source without fetching or creating a viewer. */
export function deepZoomViewerOptions(descriptor: string, tilesBase: string) {
  const image = parseDeepZoomDescriptor(descriptor)
  const firstTile = deepZoomTileUrl(tilesBase, 0, 0, 0, image.format)
  const queryIndex = firstTile.indexOf('?')
  const tilePath = queryIndex === -1 ? firstTile : firstTile.slice(0, queryIndex)
  const queryParams = queryIndex === -1 ? '' : firstTile.slice(queryIndex)
  const tilesUrl = tilePath.slice(0, -('0/0_0.' + image.format).length)

  return {
    tileSources: {
      Image: {
        xmlns: DEEP_ZOOM_NAMESPACE,
        Url: tilesUrl,
        Format: image.format,
        TileSize: image.tileSize,
        Overlap: image.overlap,
        Size: { Width: image.width, Height: image.height },
      },
      queryParams,
    },
    showNavigator: true,
    maxZoomPixelRatio: 2,
    crossOriginPolicy: 'Anonymous' as const,
  }
}
