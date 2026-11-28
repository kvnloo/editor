import { describe, expect, test } from 'bun:test'
import {
  deepZoomDescriptor,
  deepZoomLevelSize,
  deepZoomMaxLevel,
  deepZoomTiles,
} from '@pascal-app/viewer/capture'

// Read attributes from the serialized XML without a browser DOM or an XML regex.
function attributeValue(xml: string, element: string, attribute: string): string | null {
  const start = xml.indexOf('<' + element + ' ')
  if (start === -1) return null
  const end = xml.indexOf('>', start)
  if (end === -1) return null
  const prefix = ' ' + attribute + '="'
  const attributeStart = xml.indexOf(prefix, start)
  if (attributeStart === -1 || attributeStart >= end) return null
  const from = attributeStart + prefix.length
  const to = xml.indexOf('"', from)
  return to === -1 || to > end ? null : xml.slice(from, to)
}

describe('DeepZoom pyramid math', () => {
  test('onepixel depth reaches 1×1 and preserves the full-size top level', () => {
    expect(deepZoomMaxLevel(16384, 9216)).toBe(14)
    expect(deepZoomLevelSize(16384, 9216, 0)).toEqual([1, 1])
    expect(deepZoomLevelSize(16384, 9216, 13)).toEqual([8192, 4608])
    expect(deepZoomLevelSize(16384, 9216, 14)).toEqual([16384, 9216])

    const [width, height] = deepZoomLevelSize(16384, 9216, 14)
    const tiles = deepZoomTiles(width, height, 512, 1)
    expect(tiles).toHaveLength(576)
    expect(tiles[0]).toEqual({ col: 0, row: 0, x: 0, y: 0, w: 513, h: 513 })
    expect(tiles[33]).toEqual({ col: 1, row: 1, x: 511, y: 511, w: 514, h: 514 })
    expect(tiles[tiles.length - 1]).toEqual({
      col: 31,
      row: 17,
      x: 15871,
      y: 8703,
      w: 513,
      h: 513,
    })
  })

  test('a single-pixel image has only level zero and one tile', () => {
    expect(deepZoomMaxLevel(1, 1)).toBe(0)
    expect(deepZoomLevelSize(1, 1, 0)).toEqual([1, 1])
    expect(deepZoomTiles(1, 1, 512, 1)).toEqual([
      { col: 0, row: 0, x: 0, y: 0, w: 1, h: 1 },
    ])
  })

  test('asymmetric images round up at each level and clip the final tile', () => {
    expect(deepZoomMaxLevel(1000, 1)).toBe(10)
    expect(deepZoomLevelSize(1000, 1, 0)).toEqual([1, 1])
    expect(deepZoomLevelSize(1000, 1, 1)).toEqual([2, 1])
    expect(deepZoomLevelSize(1000, 1, 10)).toEqual([1000, 1])
    expect(deepZoomTiles(1000, 1, 512, 1)).toEqual([
      { col: 0, row: 0, x: 0, y: 0, w: 513, h: 1 },
      { col: 1, row: 0, x: 511, y: 0, w: 489, h: 1 },
    ])
  })

  test('DZI XML round-trips all dimensions, tile options, and format', () => {
    const options = {
      width: 16384,
      height: 9216,
      tileSize: 512,
      overlap: 1,
      format: 'webp',
    }
    const xml = deepZoomDescriptor(options)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(attributeValue(xml, 'Image', 'xmlns')).toBe(
      'http://schemas.microsoft.com/deepzoom/2008',
    )
    expect({
      width: Number(attributeValue(xml, 'Size', 'Width')),
      height: Number(attributeValue(xml, 'Size', 'Height')),
      tileSize: Number(attributeValue(xml, 'Image', 'TileSize')),
      overlap: Number(attributeValue(xml, 'Image', 'Overlap')),
      format: attributeValue(xml, 'Image', 'Format'),
    }).toEqual(options)
  })

  test('rejects invalid pyramid and tile coordinates', () => {
    expect(() => deepZoomMaxLevel(0, 1)).toThrow(RangeError)
    expect(() => deepZoomLevelSize(1, 1, 1)).toThrow(RangeError)
    expect(() => deepZoomTiles(1, 1, 0, 0)).toThrow(RangeError)
    expect(() => deepZoomTiles(1, 1, 512, 513)).toThrow(RangeError)
    expect(() =>
      deepZoomDescriptor({ width: 1, height: 1, tileSize: 512, overlap: 1, format: '' }),
    ).toThrow(RangeError)
  })
})
