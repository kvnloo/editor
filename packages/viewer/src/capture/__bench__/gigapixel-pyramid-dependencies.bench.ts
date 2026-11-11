import { planGigapixelPyramid } from '@pascal-app/viewer/capture'

// Run separately with bun; benchmark samples are not correctness or CI gates.
const median = (samples: number[]) => samples.sort((a, b) => a - b)[samples.length >> 1]!
const tileSize = 512
const overlap = 1
const results: Record<string, unknown>[] = []

for (const [width, height] of [
  [32_768, 18_432],
  [65_536, 36_864],
  [131_072, 73_728],
]) {
  const samples: number[] = []
  let topParents = 0
  let topChildren = 0
  let topEdges = 0
  for (let run = 0; run < 9; run++) {
    const started = performance.now()
    const pyramid = planGigapixelPyramid(width, height, tileSize, overlap)
    const elapsed = performance.now() - started
    if (run >= 2) samples.push(elapsed)
    const top = pyramid.dependencies.at(-1)!
    topParents = top.parents.size
    topChildren = pyramid.levels.at(-1)!.length
    topEdges = [...top.parents.values()].reduce((sum, parent) => sum + parent.children.length, 0)
  }
  results.push({
    width,
    height,
    topParents,
    topChildren,
    topEdges,
    allPairsCandidateChecks: topParents * topChildren,
    indexedBuildMedianMs: median(samples),
  })
}
console.log(JSON.stringify({ tileSize, overlap, results }, null, 2))
