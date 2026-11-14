import { describe, expect, test } from 'bun:test'
import { halveRgba } from './index'

describe('halveRgba', () => {
  test('averages a fully opaque 2x2 block into one pixel', () => {
    const { data, width, height } = halveRgba(
      new Uint8ClampedArray([
        10, 20, 30, 255, 30, 40, 50, 255,
        50, 60, 70, 255, 70, 80, 90, 255,
      ]),
      2,
      2,
    )

    expect({ width, height }).toEqual({ width: 1, height: 1 })
    expect(Array.from(data)).toEqual([40, 50, 60, 255])
    expect(data.length).toBe(width * height * 4)
  })

  test('averages only present pixels along odd edges', () => {
    const { data, width, height } = halveRgba(
      new Uint8ClampedArray([
        0, 10, 20, 255, 20, 30, 40, 255, 100, 110, 120, 255,
        40, 50, 60, 255, 60, 70, 80, 255, 120, 130, 140, 255,
        80, 90, 100, 255, 100, 110, 120, 255, 200, 210, 220, 255,
      ]),
      3,
      3,
    )

    expect({ width, height }).toEqual({ width: 2, height: 2 })
    expect(Array.from(data)).toEqual([
      30, 40, 50, 255, 110, 120, 130, 255,
      90, 100, 110, 255, 200, 210, 220, 255,
    ])
    expect(data.length).toBe(width * height * 4)
  })

  test('weights RGB by alpha and rounds the mean alpha to the nearest byte', () => {
    const { data } = halveRgba(
      new Uint8ClampedArray([
        255, 0, 0, 255, 0, 255, 0, 0,
        0, 0, 255, 0, 255, 255, 255, 0,
      ]),
      2,
      2,
    )

    expect(Array.from(data)).toEqual([255, 0, 0, 64])
  })

  test('weights partially transparent RGB without mixing hidden colours', () => {
    const { data } = halveRgba(
      new Uint8ClampedArray([
        255, 0, 0, 255, 0, 0, 255, 85,
        0, 255, 0, 0, 255, 255, 255, 0,
      ]),
      2,
      2,
    )

    expect(Array.from(data)).toEqual([191, 0, 64, 85])
  })

  test('sets all channels to zero for a fully transparent block', () => {
    const { data } = halveRgba(
      new Uint8ClampedArray([
        255, 25, 50, 0, 10, 30, 80, 0,
        20, 10, 255, 0, 40, 80, 120, 0,
      ]),
      2,
      2,
    )

    expect(Array.from(data)).toEqual([0, 0, 0, 0])
  })

  test('keeps a single pixel at 1x1', () => {
    const { data, width, height } = halveRgba(new Uint8ClampedArray([13, 27, 39, 51]), 1, 1)

    expect({ width, height }).toEqual({ width: 1, height: 1 })
    expect(Array.from(data)).toEqual([13, 27, 39, 51])
    expect(data.length).toBe(width * height * 4)
  })
})
