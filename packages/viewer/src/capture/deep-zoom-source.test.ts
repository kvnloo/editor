import { describe, expect, test } from 'bun:test'
import {
  deepZoomTilesUrl,
  deepZoomTileUrl,
  parseDeepZoomDescriptor,
} from '@pascal-app/viewer/capture'

describe('DeepZoom source', () => {
  test('ignores XML comments and processing instructions before the descriptor', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<!-- <Image TileSize="1" Overlap="0" Format="png"><Size Width="1" Height="1" /></Image> -->',
      '<?hint <Image TileSize="2" Overlap="0" Format="jpeg"><Size Width="2" Height="2" /></Image>?>',
      '<Image TileSize="512" Overlap="1" Format="webp">',
      '  <Size Width="32" Height="16" />',
      '</Image>',
    ].join('\n')

    expect(parseDeepZoomDescriptor(xml)).toEqual({
      width: 32,
      height: 16,
      tileSize: 512,
      overlap: 1,
      format: 'webp',
    })
  })

  test('parses a vips dzsave WebP descriptor', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
       TileSize="512" Overlap="1" Format="webp">
  <Size Width="16384" Height="9216" />
</Image>`

    expect(parseDeepZoomDescriptor(xml)).toEqual({
      width: 16384,
      height: 9216,
      tileSize: 512,
      overlap: 1,
      format: 'webp',
    })
  })

  test('accepts single-quoted attributes and reversed Size attribute order', () => {
    const xml = `<Image Format='png' Overlap='0' TileSize='254'>
  <Size Height='300' Width='500' />
</Image>`
    expect(parseDeepZoomDescriptor(xml)).toEqual({
      width: 500,
      height: 300,
      tileSize: 254,
      overlap: 0,
      format: 'png',
    })
  })

  test('accepts mixed quotes and whitespace around attributes', () => {
    const xml = `<Image
      Format = 'jpeg'
      TileSize = "512"
      Overlap = '1'
    >
      <Size
        Height = "9216"
        Width = '16384'
      />
    </Image>`
    expect(parseDeepZoomDescriptor(xml)).toEqual({
      width: 16384,
      height: 9216,
      tileSize: 512,
      overlap: 1,
      format: 'jpeg',
    })
  })

  test('rejects missing Size and required attributes with clear errors', () => {
    expect(() =>
      parseDeepZoomDescriptor('<Image TileSize="512" Overlap="1" Format="webp" />'),
    ).toThrow('DeepZoom descriptor missing Size element')
    expect(() =>
      parseDeepZoomDescriptor(
        '<Image TileSize="512" Overlap="1" Format="webp"><Size Height="50" /></Image>',
      ),
    ).toThrow('DeepZoom descriptor missing Width attribute')
    expect(() =>
      parseDeepZoomDescriptor(
        '<Image Overlap="1" Format="webp"><Size Width="1" Height="1" /></Image>',
      ),
    ).toThrow('DeepZoom descriptor missing TileSize attribute')
    expect(() =>
      parseDeepZoomDescriptor(
        '<Image TileSize="512" Overlap="1"><Size Width="1" Height="1" /></Image>',
      ),
    ).toThrow('DeepZoom descriptor missing Format attribute')
  })

  test('rejects invalid dimensions and overlap', () => {
    expect(() =>
      parseDeepZoomDescriptor(
        '<Image TileSize="512" Overlap="1" Format="webp"><Size Width="0" Height="1" /></Image>',
      ),
    ).toThrow('DeepZoom descriptor invalid Width: 0')
    expect(() =>
      parseDeepZoomDescriptor(
        '<Image TileSize="512" Overlap="513" Format="webp"><Size Width="1" Height="1" /></Image>',
      ),
    ).toThrow('DeepZoom descriptor Overlap exceeds TileSize')
  })

  test('maps an absolute DZI URL and keeps token queries on tiles', () => {
    const base = deepZoomTilesUrl('https://images.example.test/campus/site.dzi?token=abc')
    expect(base).toBe('https://images.example.test/campus/site_files/?token=abc')
    expect(deepZoomTileUrl(base, 14, 2, 3, 'webp')).toBe(
      'https://images.example.test/campus/site_files/14/2_3.webp?token=abc',
    )
  })

  test('maps relative and local DZI paths', () => {
    expect(deepZoomTilesUrl('../imagery/campus.dzi')).toBe('../imagery/campus_files/')
    expect(deepZoomTileUrl('../imagery/campus_files/', 0, 0, 0, 'png')).toBe(
      '../imagery/campus_files/0/0_0.png',
    )
    expect(deepZoomTilesUrl('image.dzi#viewer')).toBe('image_files/')
    expect(deepZoomTilesUrl('/capture/scan.DZI')).toBe('/capture/scan_files/')
  })

  test('rejects URLs without a DZI extension and invalid tile coordinates', () => {
    expect(() => deepZoomTilesUrl('https://images.example.test/campus/site.xml?token=abc')).toThrow(
      'DeepZoom descriptor URL must end with .dzi',
    )
    expect(() => deepZoomTileUrl('image_files/', -1, 0, 0, 'webp')).toThrow(RangeError)
  })
})
