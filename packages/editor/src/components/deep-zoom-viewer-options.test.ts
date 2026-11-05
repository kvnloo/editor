import { describe, expect, test } from 'bun:test'
import { deepZoomViewerOptions } from '@pascal-app/editor'

const descriptor =
  '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="512" Overlap="1" Format="webp"><Size Width="16384" Height="9216" /></Image>'

describe('DeepZoom viewer options', () => {
  test('uses the exact inline DZI image contract for a 16384 by 9216 WebP pyramid', () => {
    expect(deepZoomViewerOptions(descriptor, 'https://imagery.example.test/aerial_files/')).toEqual({
      tileSources: {
        Image: {
          xmlns: 'http://schemas.microsoft.com/deepzoom/2008',
          Url: 'https://imagery.example.test/aerial_files/',
          Format: 'webp',
          TileSize: 512,
          Overlap: 1,
          Size: { Width: 16384, Height: 9216 },
        },
        queryParams: '',
      },
      showNavigator: true,
      maxZoomPixelRatio: 2,
      crossOriginPolicy: 'Anonymous',
    })
  })

  test('keeps signed DZI query parameters on every tile request', () => {
    const options = deepZoomViewerOptions(descriptor, '/captures/campus_files/?token=abc')
    expect(options.tileSources.Image.Url).toBe('/captures/campus_files/')
    expect(options.tileSources.queryParams).toBe('?token=abc')
  })

  test('rejects malformed image descriptors before OpenSeadragon initialization', () => {
    expect(() =>
      deepZoomViewerOptions('<Image TileSize="512" Overlap="1" Format="webp" />', 'image_files/'),
    ).toThrow('DeepZoom descriptor missing Size element')
  })
})
