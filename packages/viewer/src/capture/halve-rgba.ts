export function halveRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
): { data: Uint8ClampedArray; width: number; height: number } {
  if (!Number.isSafeInteger(w) || w <= 0 || !Number.isSafeInteger(h) || h <= 0) {
    throw new RangeError('Image dimensions must be positive safe integers')
  }
  const byteLength = w * h * 4
  if (!Number.isSafeInteger(byteLength) || src.byteLength !== byteLength) {
    throw new RangeError('Image must contain exactly width * height * 4 packed RGBA bytes')
  }
  const pixels = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const width = Math.ceil(w / 2)
  const height = Math.ceil(h / 2)
  const data = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = x * 2
      const sourceY = y * 2
      const endX = Math.min(sourceX + 2, w)
      const endY = Math.min(sourceY + 2, h)
      const pixelCount = (endX - sourceX) * (endY - sourceY)
      let alphaSum = 0
      let redSum = 0
      let greenSum = 0
      let blueSum = 0

      for (let sy = sourceY; sy < endY; sy++) {
        for (let sx = sourceX; sx < endX; sx++) {
          const offset = (sy * w + sx) * 4
          const alpha = pixels.getUint8(offset + 3)
          alphaSum += alpha
          redSum += pixels.getUint8(offset) * alpha
          greenSum += pixels.getUint8(offset + 1) * alpha
          blueSum += pixels.getUint8(offset + 2) * alpha
        }
      }

      const target = (y * width + x) * 4
      if (alphaSum > 0) {
        data[target] = Math.round(redSum / alphaSum)
        data[target + 1] = Math.round(greenSum / alphaSum)
        data[target + 2] = Math.round(blueSum / alphaSum)
      }
      data[target + 3] = Math.round(alphaSum / pixelCount)
    }
  }

  return { data, width, height }
}
