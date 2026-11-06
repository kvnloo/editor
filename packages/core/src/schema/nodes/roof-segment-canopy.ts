import { getGableRidge, type RoofSegmentNode } from './roof-segment'

export type RoofPlanRing = [number, number][]

type OutlineInput = Pick<
  RoofSegmentNode,
  'width' | 'depth' | 'wallThickness' | 'footprint' | 'coverFootprint'
>

/**
 * The outer face of the walls a segment stands on, segment-local: its drawn
 * outline, else its rectangle pushed out by half the wall thickness.
 */
export function getRoofSegmentWallOutline(node: OutlineInput): RoofPlanRing {
  if (node.footprint && node.footprint.length >= 3) {
    return node.footprint.map(([x, z]) => [x, z])
  }
  const x = node.width / 2 + node.wallThickness / 2
  const z = node.depth / 2 + node.wallThickness / 2
  return [
    [-x, -z],
    [x, -z],
    [x, z],
    [-x, z],
  ]
}

/**
 * What the roof covers, segment-local: past the walls where it was pulled out
 * as a canopy. A wall corner on one of its edges splits that edge there, so a
 * canopy reaching on past the wall line has a side of its own to pull.
 */
export function getRoofSegmentCoverOutline(node: OutlineInput): RoofPlanRing {
  if (!(node.coverFootprint && node.coverFootprint.length >= 3)) {
    return getRoofSegmentWallOutline(node)
  }
  const cover = node.coverFootprint
  const walls = getRoofSegmentWallOutline(node)
  const ring: RoofPlanRing = []
  for (let i = 0; i < cover.length; i++) {
    const [ax, az] = cover[i]!
    const [bx, bz] = cover[(i + 1) % cover.length]!
    ring.push([ax, az])
    const length = Math.hypot(bx - ax, bz - az)
    if (length < 1e-9) continue
    const ux = (bx - ax) / length
    const uz = (bz - az) / length
    const inner = walls
      .map(([x, z]) => ({ t: (x - ax) * ux + (z - az) * uz, off: (x - ax) * uz - (z - az) * ux }))
      .filter(({ t, off }) => Math.abs(off) < 1e-6 && t > 1e-6 && t < length - 1e-6)
      .sort((p, q) => p.t - q.t)
    for (const { t } of inner) ring.push([ax + ux * t, az + uz * t])
  }
  return ring
}

function signedArea(ring: readonly (readonly [number, number])[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, z1] = ring[i]!
    const [x2, z2] = ring[(i + 1) % ring.length]!
    area += x1 * z2 - x2 * z1
  }
  return area / 2
}

/** Unit outward normal of a ring edge (x, z), whichever way the ring winds. */
export function getRoofRingEdgeNormal(
  ring: readonly (readonly [number, number])[],
  edgeIndex: number,
): [number, number] {
  const [x1, z1] = ring[edgeIndex]!
  const [x2, z2] = ring[(edgeIndex + 1) % ring.length]!
  const length = Math.hypot(x2 - x1, z2 - z1) || 1
  const ccw = signedArea(ring) > 0
  const dx = (x2 - x1) / length
  const dz = (z2 - z1) / length
  return ccw ? [dz, -dx] : [-dz, dx]
}

const RING_EPSILON = 1e-6

/** An edge's start, end, unit direction, outward normal and length. */
function ringEdgeFrame(ring: RoofPlanRing, edgeIndex: number) {
  const p = ring[edgeIndex]!
  const q = ring[(edgeIndex + 1) % ring.length]!
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
  const u: [number, number] = [(q[0] - p[0]) / length, (q[1] - p[1]) / length]
  return { p, q, u, n: getRoofRingEdgeNormal(ring, edgeIndex), length }
}

/**
 * How far edge `edgeIndex` of `ring` may come in: up to the nearest of the
 * obstacles' edges behind it, across its own span (what only touches its ends
 * does not count). −Infinity when nothing is behind it.
 */
function inwardLimit(
  ring: RoofPlanRing,
  edgeIndex: number,
  obstacles: { ring: RoofPlanRing; skip?: number }[],
): number {
  const { p, u, n, length } = ringEdgeFrame(ring, edgeIndex)
  const local = ([x, z]: [number, number]) => {
    const dx = x - p[0]
    const dz = z - p[1]
    return { t: dx * u[0] + dz * u[1], s: dx * n[0] + dz * n[1] }
  }
  let limit = Number.NEGATIVE_INFINITY
  for (const { ring: other, skip } of obstacles) {
    for (let i = 0; i < other.length; i++) {
      if (i === skip) continue
      let a = local(other[i]!)
      let b = local(other[(i + 1) % other.length]!)
      if (a.t > b.t) [a, b] = [b, a]
      const lo = Math.max(a.t, RING_EPSILON)
      const hi = Math.min(b.t, length - RING_EPSILON)
      if (lo > hi) continue
      const at = (t: number) =>
        b.t - a.t < 1e-12 ? Math.max(a.s, b.s) : a.s + ((b.s - a.s) * (t - a.t)) / (b.t - a.t)
      for (const s of [at(lo), at(hi)]) {
        if (s <= RING_EPSILON) limit = Math.max(limit, Math.min(s, 0))
      }
    }
  }
  return limit
}

/**
 * The ring with no repeated points and no point where it turns straight back
 * on itself. Points on a straight run stay: a wall corner the covering was
 * pulled out from is still where it was.
 */
function tidyRing(ring: RoofPlanRing): RoofPlanRing {
  const points = ring.map(([x, z]) => [x, z] as [number, number])
  let changed = true
  while (changed && points.length > 3) {
    changed = false
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i - 1 + points.length) % points.length]!
      const point = points[i]!
      const next = points[(i + 1) % points.length]!
      const ax = point[0] - prev[0]
      const az = point[1] - prev[1]
      const bx = next[0] - point[0]
      const bz = next[1] - point[1]
      const repeated = Math.hypot(ax, az) < RING_EPSILON
      const backtrack =
        Math.abs(ax * bz - az * bx) < RING_EPSILON * Math.max(1, Math.hypot(ax, az)) &&
        ax * bx + az * bz < 0
      if (repeated || backtrack) {
        points.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return points
}

/**
 * The covering with edge `edgeIndex` pulled `distance` along its outward
 * normal. An edge on the walls is pushed out as a new piece: its corners stay
 * on the walls and the piece grows out of them. An edge out past the walls
 * moves: at each end it slides along a neighbour running across it, and where
 * the neighbour runs on in its line (a piece's side against a wall corner)
 * that point stays and a new one leads out of it, so a piece's sides narrow or
 * widen that piece alone. The pulled edge keeps its index.
 */
function pullCoverEdge(
  cover: RoofPlanRing,
  walls: RoofPlanRing,
  edgeIndex: number,
  distance: number,
): RoofPlanRing {
  const count = cover.length
  const { p, q, u, n } = ringEdgeFrame(cover, edgeIndex)
  const onWalls = inwardLimit(cover, edgeIndex, [{ ring: walls }]) > -RING_EPSILON
  const inLine = (from: [number, number], to: [number, number]) =>
    Math.abs((to[0] - from[0]) * u[1] - (to[1] - from[1]) * u[0]) < RING_EPSILON
  const previous = cover[(edgeIndex - 1 + count) % count]!
  const next = cover[(edgeIndex + 2) % count]!
  const keepStart = onWalls || inLine(previous, p)
  const keepEnd = onWalls || inLine(q, next)

  const moved: [[number, number], [number, number]] = [
    [p[0] + n[0] * distance, p[1] + n[1] * distance],
    [q[0] + n[0] * distance, q[1] + n[1] * distance],
  ]
  // where the moved edge's line meets a neighbour's line
  const meet = (a: [number, number], b: [number, number], fallback: [number, number]) => {
    const [ex, ez] = [moved[1][0] - moved[0][0], moved[1][1] - moved[0][1]]
    const [fx, fz] = [b[0] - a[0], b[1] - a[1]]
    const denominator = ex * fz - ez * fx
    if (Math.abs(denominator) < 1e-12) return fallback
    const t = ((a[0] - moved[0][0]) * fz - (a[1] - moved[0][1]) * fx) / denominator
    return [moved[0][0] + ex * t, moved[0][1] + ez * t] as [number, number]
  }
  const start = keepStart ? moved[0] : meet(previous, p, moved[0])
  const end = keepEnd ? moved[1] : meet(q, next, moved[1])

  // the edge rebuilt at the head, then the rest of the ring from its end on
  const rebuilt: RoofPlanRing = [...(keepStart ? [p] : []), start, end, ...(keepEnd ? [q] : [])]
  for (let k = 2; k < count; k++) rebuilt.push(cover[(edgeIndex + k) % count]!)
  // turned so the pulled edge sits at its index again
  const head = keepStart ? 1 : 0
  const size = rebuilt.length
  const turned = rebuilt.map((_, k) => rebuilt[(((k - edgeIndex + head) % size) + size) % size]!)
  return tidyRing(turned)
}

/**
 * Pull one edge of what a gable covers out past the walls (or back toward
 * them) by `distance`, as a canopy: the slopes run on in their own planes,
 * the ridge keeps its place and height, and the roof's own walls stay on the
 * building. The segment is rebuilt over the rectangle bounding the walls and
 * the covering, so it moves and resizes with it. Null for anything but a
 * sloped gable.
 */
export function pullRoofSegmentCoverEdge(
  node: RoofSegmentNode,
  edgeIndex: number,
  distance: number,
): Partial<RoofSegmentNode> | null {
  const ridge = getGableRidge(node)
  if (!ridge) return null
  const walls = getRoofSegmentWallOutline(node)
  const cover = getRoofSegmentCoverOutline(node)
  if (edgeIndex < 0 || edgeIndex >= cover.length) return null
  // never in past the walls, nor through the covering's far side
  const limit = inwardLimit(cover, edgeIndex, [{ ring: walls }, { ring: cover, skip: edgeIndex }])
  const pulled = pullCoverEdge(cover, walls, edgeIndex, Math.max(limit, distance))

  // the rectangle the roof is built over: bounding the walls and the covering
  const points = [...walls, ...pulled]
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minZ = Math.min(...points.map(([, z]) => z))
  const maxZ = Math.max(...points.map(([, z]) => z))
  const shiftX = (minX + maxX) / 2
  const shiftZ = (minZ + maxZ) / 2
  const width = maxX - minX
  const depth = maxZ - minZ

  // the slope planes stay put: same ridge line and height, the +z eave moves
  // with the rectangle's edge down (or up) the front slope
  const ridgeZ = ridge.ridgeZ - shiftZ
  const ridgeOffset = depth / 2 - ridgeZ
  const wallHeight = ridge.height - ridgeOffset * Math.tan((ridge.frontPitch * Math.PI) / 180)

  // the segment's origin follows the rectangle's centre (rotation-y, as the roof renders it)
  const rotation = node.rotation ?? 0
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const position: [number, number, number] = [
    node.position[0] + shiftX * cos + shiftZ * sin,
    node.position[1],
    node.position[2] - shiftX * sin + shiftZ * cos,
  ]
  const local = (ring: RoofPlanRing): RoofPlanRing => ring.map(([x, z]) => [x - shiftX, z - shiftZ])

  return {
    position,
    width,
    depth,
    wallHeight,
    ridgeOffset,
    backPitch: ridge.backPitch,
    footprint: local(walls),
    coverFootprint: local(pulled),
  }
}

/**
 * How far a gable's rectangle edges sit past the walls on its +z and −z
 * sides (a canopy pulled out there): the ridge group is read and edited
 * against the walls, not the canopy's edge.
 */
export function getGableWallInsets(node: OutlineInput): { front: number; back: number } {
  const walls = getRoofSegmentWallOutline(node)
  const maxZ = Math.max(...walls.map(([, z]) => z))
  const minZ = Math.min(...walls.map(([, z]) => z))
  return {
    front: Math.max(0, node.depth / 2 - maxZ),
    back: Math.max(0, node.depth / 2 + minZ),
  }
}

type PlanPoint = RoofPlanRing[number]

/**
 * A plan ring pushed outward (negative: inward) by `distance`, edges kept
 * parallel. Repeated points (a pulled canopy edge can leave one) are dropped
 * first: an edge of no length has no direction to push.
 */
export function offsetPlanRing(ring: readonly PlanPoint[], distance: number): PlanPoint[] {
  const clean = ring.filter((point, i) => {
    const next = ring[(i + 1) % ring.length]!
    return Math.hypot(next[0] - point[0], next[1] - point[1]) > 1e-9
  })
  if (clean.length < 3) return [...ring]
  if (distance > 0 && isAxisRing(clean)) return growAxisRing(clean, distance)
  const ccw = signedArea(clean) > 0
  const count = clean.length
  const lines = clean.map((point, i) => {
    const next = clean[(i + 1) % count]!
    const dx = next[0] - point[0]
    const dz = next[1] - point[1]
    const length = Math.hypot(dx, dz)
    // Outward normal: right of the direction for a counter-clockwise (x, z) ring.
    const nx = (ccw ? dz : -dz) / length
    const nz = (ccw ? -dx : dx) / length
    return { x: point[0] + nx * distance, z: point[1] + nz * distance, dx, dz }
  })
  return clean.map((point, i): PlanPoint => {
    const a = lines[(i - 1 + count) % count]!
    const b = lines[i]!
    const denominator = a.dx * b.dz - a.dz * b.dx
    if (Math.abs(denominator) < 1e-12) return [b.x, b.z]
    const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / denominator
    return [a.x + a.dx * t, a.z + a.dz * t]
  })
}

/** Whether every edge of a ring runs along x or along z. */
function isAxisRing(ring: readonly PlanPoint[]): boolean {
  return ring.every((point, i) => {
    const next = ring[(i + 1) % ring.length]!
    return Math.abs(next[0] - point[0]) < 1e-9 || Math.abs(next[1] - point[1]) < 1e-9
  })
}

/**
 * An axis-aligned ring grown outward by `distance`, as the edge-by-edge push
 * would grow it, but sound where that push folds over: a notch or a slot
 * narrower than twice the distance closes instead of turning inside out.
 * The grown ring is everything within `distance` of the ring along x and z
 * (its mitred corners are square), worked out on the grid of the pushed
 * coordinates; a courtyard it would leave is filled.
 */
function growAxisRing(ring: readonly PlanPoint[], distance: number): PlanPoint[] {
  const unique = (values: number[]) =>
    [...new Set(values.map((v) => Math.round(v * 1e9) / 1e9))].sort((a, b) => a - b)
  const xs = unique(ring.flatMap(([x]) => [x - distance, x + distance]))
  const zs = unique(ring.flatMap(([, z]) => [z - distance, z + distance]))
  const inside = (x: number, z: number) => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i]!
      const [xj, zj] = ring[j]!
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
    }
    return hit
  }
  // a cell is covered when the square of half-size `distance` about its
  // centre meets the ring's area: the centre is inside, or an edge crosses it
  const near = (x: number, z: number) => {
    if (inside(x, z)) return true
    const d = distance - 1e-9
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i]!
      const [bx, bz] = ring[(i + 1) % ring.length]!
      if (
        Math.max(ax, bx) >= x - d &&
        Math.min(ax, bx) <= x + d &&
        Math.max(az, bz) >= z - d &&
        Math.min(az, bz) <= z + d
      ) {
        return true
      }
    }
    return false
  }
  const nx = xs.length - 1
  const nz = zs.length - 1
  const covered: boolean[] = []
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      covered.push(near((xs[i]! + xs[i + 1]!) / 2, (zs[j]! + zs[j + 1]!) / 2))
    }
  }
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && covered[j * nx + i]!
  // the boundary as directed edges between grid nodes, the covered cells on
  // their left (x right, z down: counter-clockwise in the plan's signed area)
  const next = new Map<string, [number, number][]>()
  const key = (i: number, j: number) => `${i},${j}`
  const link = (a: [number, number], b: [number, number]) => {
    const list = next.get(key(...a)) ?? []
    list.push(b)
    next.set(key(...a), list)
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j)) continue
      if (!at(i, j - 1)) link([i, j], [i + 1, j])
      if (!at(i + 1, j)) link([i + 1, j], [i + 1, j + 1])
      if (!at(i, j + 1)) link([i + 1, j + 1], [i, j + 1])
      if (!at(i - 1, j)) link([i, j + 1], [i, j])
    }
  }
  // chain the loops; the outer one encloses the most
  let best: PlanPoint[] = []
  let bestArea = 0
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: [number, number][] = []
      let current = start.split(',').map(Number) as [number, number]
      let previous: [number, number] | null = null
      do {
        loop.push(current)
        const options = next.get(key(...current))!
        // at a node where two corners touch, turn the tightest way
        let pick = 0
        if (options.length > 1 && previous) {
          const dx = current[0] - previous[0]
          const dz = current[1] - previous[1]
          pick = options.findIndex(([a, b]) => dx * (b - current[1]) - dz * (a - current[0]) > 0)
          if (pick < 0) pick = 0
        }
        const [following] = options.splice(pick, 1)
        previous = current
        current = following!
      } while (key(...current) !== key(...loop[0]!) && loop.length <= covered.length * 4)
      const points = loop.map(([i, j]): PlanPoint => [xs[i]!, zs[j]!])
      const area = Math.abs(signedArea(points))
      if (area > bestArea) {
        bestArea = area
        best = points
      }
    }
  }
  // straight runs as one edge
  const corners = best.filter((point, i) => {
    const a = best[(i - 1 + best.length) % best.length]!
    const b = best[(i + 1) % best.length]!
    return (
      Math.abs((point[0] - a[0]) * (b[1] - point[1]) - (point[1] - a[1]) * (b[0] - point[0])) >
      1e-12
    )
  })
  // the ring's own winding
  return signedArea(corners) > 0 === signedArea(ring) > 0 ? corners : corners.reverse()
}
