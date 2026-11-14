export interface ParsedDeepZoomDescriptor {
  width: number
  height: number
  tileSize: number
  overlap: number
  format: string
}

function elementAttributes(xml: string, element: string): Map<string, string> {
  const tag = new RegExp(`<${element}\\b[^>]*>`).exec(xml)?.[0]
  if (!tag) throw new Error(`DeepZoom descriptor missing ${element} element`)

  const attributes = new Map<string, string>()
  const attributePattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1]
    if (name) attributes.set(name, match[2] ?? match[3] ?? '')
  }
  return attributes
}

function requiredAttribute(attributes: Map<string, string>, name: string): string {
  const value = attributes.get(name)
  if (!value?.trim()) throw new Error(`DeepZoom descriptor missing ${name} attribute`)
  return value.trim()
}

function integerAttribute(
  attributes: Map<string, string>,
  name: string,
  minimum: number,
): number {
  const raw = requiredAttribute(attributes, name)
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`DeepZoom descriptor invalid ${name}: ${raw}`)
  }
  return value
}

export function parseDeepZoomDescriptor(xml: string): ParsedDeepZoomDescriptor {
  const image = elementAttributes(xml, 'Image')
  const size = elementAttributes(xml, 'Size')

  const width = integerAttribute(size, 'Width', 1)
  const height = integerAttribute(size, 'Height', 1)
  const tileSize = integerAttribute(image, 'TileSize', 1)
  const overlap = integerAttribute(image, 'Overlap', 0)
  const format = requiredAttribute(image, 'Format').toLowerCase()

  if (overlap > tileSize) throw new Error('DeepZoom descriptor Overlap exceeds TileSize')
  if (!/^[a-z0-9]+$/.test(format)) {
    throw new Error(`DeepZoom descriptor invalid Format: ${format}`)
  }

  return { width, height, tileSize, overlap, format }
}

export function deepZoomTilesUrl(dziUrl: string): string {
  const match = /^(.+)\.dzi(\?[^#]*)?(?:#.*)?$/i.exec(dziUrl)
  if (!match) throw new Error('DeepZoom descriptor URL must end with .dzi')
  return `${match[1]}_files/${match[2] ?? ''}`
}

export function deepZoomTileUrl(
  base: string,
  level: number,
  col: number,
  row: number,
  format: string,
): string {
  if (![level, col, row].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new RangeError('DeepZoom tile coordinates must be non-negative safe integers')
  }
  if (!/^[a-z0-9]+$/i.test(format)) throw new Error('DeepZoom tile format is invalid')

  const queryStart = base.indexOf('?')
  const directory = queryStart === -1 ? base : base.slice(0, queryStart)
  const query = queryStart === -1 ? '' : base.slice(queryStart)
  const trailingSlash = directory.endsWith('/') ? '' : '/'
  return `${directory}${trailingSlash}${level}/${col}_${row}.${format}${query}`
}
