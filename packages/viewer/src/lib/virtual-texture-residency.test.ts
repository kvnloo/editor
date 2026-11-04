import { describe, expect, test } from 'bun:test'
import { COARSE_FALLBACK, createResidency } from '@pascal-app/viewer'

describe('virtual-texture residency', () => {
  test('a 2048/256 atlas has 64 slots and 16,777,216 RGBA8 bytes', () => {
    const residency = createResidency({ atlasSize: 2048, pageSize: 256 })
    expect(residency.slotCount).toBe(64)
    expect(residency.atlasBytes).toBe(16_777_216)
    expect(residency.lookup('level8/255/255')).toBe(COARSE_FALLBACK)
  })

  test('the 65th page evicts exactly the least recently used page', () => {
    const residency = createResidency({ atlasSize: 2048, pageSize: 256 })
    for (let index = 0; index < 64; index++) {
      expect(residency.request(`page-${index}`, 1)).toBe(true)
      expect(residency.commit(`page-${index}`, 1)).toBe(index)
    }

    expect(residency.lookup('page-0')).toBe(0)
    expect(residency.request('page-64', 1)).toBe(true)
    expect(residency.commit('page-64', 1)).toBe(1)

    expect(residency.lookup('page-1')).toBe(COARSE_FALLBACK)
    expect(residency.lookup('page-64')).toBe(1)
    for (let index = 0; index < 64; index++) {
      if (index !== 1) expect(residency.lookup(`page-${index}`)).toBe(index)
    }
  })

  test('an old generation cannot replace a newer resident page', () => {
    const residency = createResidency({ atlasSize: 256, pageSize: 256 })
    expect(residency.request('facade/0/0', 4)).toBe(true)
    expect(residency.request('facade/0/0', 5)).toBe(true)
    expect(residency.commit('facade/0/0', 4)).toBeNull()
    expect(residency.lookup('facade/0/0')).toBe(COARSE_FALLBACK)
    expect(residency.commit('facade/0/0', 5)).toBe(0)

    expect(residency.request('facade/0/0', 6)).toBe(true)
    expect(residency.commit('facade/0/0', 6)).toBe(0)
    expect(residency.commit('facade/0/0', 5)).toBeNull()
    expect(residency.request('facade/0/0', 5)).toBe(false)
    expect(residency.lookup('facade/0/0')).toBe(0)
  })

  test('unrequested and uncommitted pages use coarse fallback', () => {
    const residency = createResidency({ atlasSize: 512, pageSize: 256 })
    expect(residency.commit('absent', 1)).toBeNull()
    expect(residency.lookup('absent')).toBe(COARSE_FALLBACK)
    expect(residency.request('queued', 2)).toBe(true)
    expect(residency.lookup('queued')).toBe(COARSE_FALLBACK)
    expect(residency.commit('queued', 2)).toBe(0)
    expect(residency.lookup('queued')).toBe(0)
  })

  test('rejects malformed sizes, page identifiers, and generations', () => {
    expect(() => createResidency({ atlasSize: 2048, pageSize: 0 })).toThrow(RangeError)
    expect(() => createResidency({ atlasSize: 2049, pageSize: 256 })).toThrow(RangeError)
    expect(() => createResidency({ atlasSize: Number.MAX_SAFE_INTEGER, pageSize: 1 })).toThrow(RangeError)
    const residency = createResidency({ atlasSize: 256, pageSize: 256 })
    expect(() => residency.request('', 1)).toThrow(TypeError)
    expect(() => residency.request('page', -1)).toThrow(RangeError)
    expect(() => residency.commit('page', Number.NaN)).toThrow(RangeError)
  })
})
