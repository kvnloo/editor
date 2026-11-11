import { afterEach, describe, expect, test } from 'bun:test'
import { createJSONStorage } from 'zustand/middleware'

const STORAGE_KEY = 'sidebar-preferences'

function memoryStorage() {
  const items = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
  return { items, localStorage, storage: createJSONStorage(() => localStorage) }
}

// The exported store needs browser storage when it is first constructed:
// without it, Zustand omits the persist API in a headless Bun process.
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const bootstrap = memoryStorage()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: bootstrap.localStorage },
})
const { useSidebarStore } = await import('@pascal-app/editor')
if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow)
else Reflect.deleteProperty(globalThis, 'window')

const originalStorage = useSidebarStore.persist.getOptions().storage

afterEach(() => {
  useSidebarStore.setState({
    width: 360,
    isCollapsed: false,
    chatWidth: 360,
    isMenuHidden: false,
  })
  useSidebarStore.persist.setOptions({ storage: originalStorage })
})

describe('v2 chat-column width contract', () => {
  test('clamps an undersized programmatic width', () => {
    useSidebarStore.getState().setChatWidth(280)
    expect(useSidebarStore.getState().chatWidth).toBe(320)
  })

  test('preserves an in-range programmatic width', () => {
    useSidebarStore.getState().setChatWidth(360)
    expect(useSidebarStore.getState().chatWidth).toBe(360)
  })

  test('clamps an oversized programmatic width', () => {
    useSidebarStore.getState().setChatWidth(800)
    expect(useSidebarStore.getState().chatWidth).toBe(600)
  })

  test('persists the clamped value rather than the requested value', () => {
    const { items, storage } = memoryStorage()
    useSidebarStore.persist.setOptions({ storage })
    useSidebarStore.getState().setChatWidth(800)
    expect(JSON.parse(items.get(STORAGE_KEY)!).state.chatWidth).toBe(600)
  })

  test('normalizes saved widths when preferences are hydrated', async () => {
    const { items, storage } = memoryStorage()
    useSidebarStore.persist.setOptions({ storage })
    for (const [saved, expected] of [
      [280, 320],
      [360, 360],
      [800, 600],
    ] as const) {
      items.set(STORAGE_KEY, JSON.stringify({ state: { chatWidth: saved }, version: 0 }))
      await useSidebarStore.persist.rehydrate()
      expect(useSidebarStore.getState().chatWidth).toBe(expected)
    }
  })

  test('restores preferences saved before the chat column existed', async () => {
    const { items, storage } = memoryStorage()
    useSidebarStore.persist.setOptions({ storage })
    items.set(
      STORAGE_KEY,
      JSON.stringify({ state: { width: 420, isCollapsed: true }, version: 0 }),
    )
    await useSidebarStore.persist.rehydrate()
    expect(useSidebarStore.getState().chatWidth).toBe(360)
    expect(useSidebarStore.getState().width).toBe(420)
    expect(useSidebarStore.getState().isCollapsed).toBe(true)
  })
})
