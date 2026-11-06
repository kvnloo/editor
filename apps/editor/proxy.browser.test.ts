import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { BuildingNode, LevelNode, SiteNode } from '@pascal-app/core/schema'
import { chromium, type Browser } from 'playwright-core'

// Exercised against the running standalone Next app, not an isolated React render.
const origin = process.env.PASCAL_HYDRATION_ORIGIN ?? 'http://127.0.0.1:3002'
const sceneId = `locale-hydration-${randomUUID()}`
const hydrationDiagnostic =
  /hydrat|server[- ]rendered|did not match|text content does not match|(?:react\.dev\/errors\/|Minified React error #)(?:418|423|425)/i

const locales = [
  { requested: 'zh-CN', canonical: 'zh-CN', generated: '4 层' },
  { requested: 'zh-Hans', canonical: 'zh-Hans', generated: '4 层' },
  { requested: 'zh-hans-cn', canonical: 'zh-Hans-CN', generated: '4 层' },
  { requested: 'zh-Hant', canonical: 'zh-Hant', generated: 'Floor 3' },
  { requested: 'zh-TW', canonical: 'zh-TW', generated: 'Floor 3' },
] as const

let browser: Browser | undefined
let created = false

beforeAll(async () => {
  const generated = LevelNode.parse({
    id: 'level_locale_generated',
    parentId: 'building_locale_hydration',
    level: 3,
    height: 3,
    name: 'Floor 3',
  })
  const authored = LevelNode.parse({
    id: 'level_locale_authored',
    parentId: 'building_locale_hydration',
    level: -2,
    height: 3.25,
    name: 'Atrium mezzanine',
  })
  const building = BuildingNode.parse({
    id: 'building_locale_hydration',
    parentId: 'site_locale_hydration',
    children: [generated.id, authored.id],
  })
  const site = SiteNode.parse({
    id: 'site_locale_hydration',
    children: [building.id],
  })

  const response = await fetch(new URL('/api/scenes', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: sceneId,
      name: 'Locale hydration regression',
      graph: {
        nodes: Object.fromEntries(
          [site, building, generated, authored].map((node) => [node.id, node]),
        ),
        rootNodeIds: [site.id],
      },
    }),
  })
  if (response.status !== 201) {
    throw new Error(`Scene setup failed (${response.status}): ${await response.text()}`)
  }
  created = true
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  })
})

afterAll(async () => {
  await browser?.close()
  if (created) {
    const response = await fetch(new URL(`/api/scenes/${sceneId}`, origin), {
      method: 'DELETE',
    })
    expect(response.status).toBe(204)
  }
})

for (const { requested, canonical, generated } of locales) {
  test(`the standalone ${requested} response hydrates with matching level labels`, async () => {
    if (!browser) throw new Error('Chromium was not launched')

    const url = new URL(`/project/${sceneId}`, origin)
    url.searchParams.set('lang', requested)

    // This HTTP response passed through the real Next request proxy and root layout.
    const serverResponse = await fetch(url, { redirect: 'manual' })
    expect(serverResponse.status).toBe(200)
    expect(serverResponse.headers.get('content-type')).toContain('text/html')
    const serverHtml = await serverResponse.text()
    expect(serverHtml.match(/<html\b[^>]*\blang="([^"]+)"/i)?.[1]).toBe(canonical)

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const page = await context.newPage()
      const hydrationWarnings: string[] = []
      page.on('console', (message) => {
        if (
          (message.type() === 'warning' || message.type() === 'error') &&
          hydrationDiagnostic.test(message.text())
        ) {
          hydrationWarnings.push(message.text())
        }
      })
      page.on('pageerror', (error) => {
        if (hydrationDiagnostic.test(error.message)) hydrationWarnings.push(error.message)
      })

      const navigation = await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })
      expect(navigation?.status()).toBe(200)

      // The selector is populated only after the persisted graph reaches the live editor.
      const selector = page.locator('[data-surface="level-selector"]')
      const generatedRow = selector.locator(`button[title="${generated}"]`)
      const authoredRow = selector.locator('button[title="Atrium mezzanine"]')
      await generatedRow.waitFor({ state: 'visible', timeout: 60_000 })
      await authoredRow.waitFor({ state: 'visible', timeout: 60_000 })
      expect((await generatedRow.textContent())?.trim()).toBe(generated)
      expect((await authoredRow.textContent())?.trim()).toBe('Atrium mezzanine')

      // Wait for the client-side locale effect as well as actual interactive hydration.
      await generatedRow.click()
      expect(await page.locator('html').getAttribute('lang')).toBe(canonical)
      expect(hydrationWarnings).toEqual([])
    } finally {
      await context.close()
    }
  }, 90_000)
}
