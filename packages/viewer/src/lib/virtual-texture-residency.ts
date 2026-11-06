// Residency bookkeeping only: no atlas allocation, GPU upload, or page-table writes.
// The host publishes a page with commit() only after its upload is complete.
export const COARSE_FALLBACK = 'coarse' as const

export type ResidencyLookup = number | typeof COARSE_FALLBACK
export type ResidencyPageId = string

export interface ResidencyOptions {
  atlasSize: number
  pageSize: number
}

interface ResidentPage {
  slot: number
  generation: number
}

function validatePageRequest(pageId: ResidencyPageId, generation: number): void {
  if (typeof pageId !== 'string' || pageId.length === 0) {
    throw new TypeError('pageId must be a non-empty string')
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('generation must be a non-negative safe integer')
  }
}

/**
 * Tracks a bounded physical RGBA8 atlas independently of any logical texture size.
 * Lookup is an LRU use; requests do not consume or evict atlas slots until committed.
 */
export function createResidency({ atlasSize, pageSize }: ResidencyOptions) {
  if (
    !Number.isSafeInteger(atlasSize) ||
    !Number.isSafeInteger(pageSize) ||
    atlasSize <= 0 ||
    pageSize <= 0 ||
    atlasSize % pageSize !== 0
  ) {
    throw new RangeError('atlasSize must be a positive multiple of pageSize')
  }

  const gridSize = atlasSize / pageSize
  const slotCount = gridSize * gridSize
  const atlasBytes = atlasSize * atlasSize * 4
  if (!Number.isSafeInteger(slotCount) || !Number.isSafeInteger(atlasBytes)) {
    throw new RangeError('atlas exceeds safe integer bounds')
  }

  // Map insertion order is LRU order: oldest first, most recently used last.
  const resident = new Map<ResidencyPageId, ResidentPage>()
  const pending = new Map<ResidencyPageId, number>()
  let nextFreeSlot = 0

  function touch(pageId: ResidencyPageId, page: ResidentPage) {
    resident.delete(pageId)
    resident.set(pageId, page)
  }

  return {
    slotCount,
    atlasBytes,

    request(pageId: ResidencyPageId, generation: number): boolean {
      validatePageRequest(pageId, generation)
      const current = resident.get(pageId)
      const requested = pending.get(pageId)
      if (
        (current !== undefined && generation < current.generation) ||
        (requested !== undefined && generation < requested)
      ) {
        return false
      }

      if (current !== undefined) touch(pageId, current)
      if (current?.generation !== generation) pending.set(pageId, generation)
      return true
    },

    // A stale/unrequested generation returns null and never changes residency.
    commit(pageId: ResidencyPageId, generation: number): number | null {
      validatePageRequest(pageId, generation)
      if (pending.get(pageId) !== generation) return null

      const current = resident.get(pageId)
      if (current !== undefined && generation < current.generation) return null

      let slot: number
      if (current !== undefined) {
        slot = current.slot
      } else if (nextFreeSlot < slotCount) {
        slot = nextFreeSlot++
      } else {
        const oldest = resident.entries().next().value
        if (oldest === undefined) throw new Error('no resident slot to evict')
        slot = oldest[1].slot
        resident.delete(oldest[0])
      }

      pending.delete(pageId)
      touch(pageId, { slot, generation })
      return slot
    },

    lookup(pageId: ResidencyPageId): ResidencyLookup {
      const page = resident.get(pageId)
      if (page === undefined) return COARSE_FALLBACK
      touch(pageId, page)
      return page.slot
    },
  }
}
