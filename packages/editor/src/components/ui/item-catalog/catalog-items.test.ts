import { expect, test } from 'bun:test'
import { CATALOG_ITEMS } from '@pascal-app/editor/catalog'

test('the public editor catalog keeps urinal and legacy toilet placement contracts', () => {
  const urinals = CATALOG_ITEMS.filter((item) => item.id === 'urinal')
  expect(urinals).toHaveLength(1)
  expect(urinals[0]).toMatchObject({
    id: 'urinal',
    category: 'bathroom',
    attachTo: 'wall-side',
    dimensions: [0.4, 0.65, 0.35],
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    src: '/items/urinal/model.glb',
    thumbnail: '/items/urinal/thumbnail.png',
    floorPlanUrl: '/items/urinal/floor-plan.png',
  })

  const toilet = CATALOG_ITEMS.find((item) => item.id === 'toilet')
  expect(toilet?.dimensions).toEqual([0.42, 0.82, 0.72])
  expect(toilet?.attachTo).toBeUndefined()
})
