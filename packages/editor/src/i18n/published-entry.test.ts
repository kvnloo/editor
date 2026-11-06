import { expect, test } from 'bun:test'
import {
  createSceneEnvironment,
  createSceneStore,
  loadCanonicalSnapshot,
  sceneDocumentOf,
  type SceneSnapshot,
} from '@pascal-app/core/runtime'
import { BuildingNode, LevelNode, SiteNode } from '@pascal-app/core/schema'
import {
  createI18n,
  localizedLevelName,
  PascalI18nProvider,
  useLocale,
  usePascalI18n,
} from '@pascal-app/editor'
import { registerBundledLocales } from '@pascal-app/editor/locales'
import { createElement } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'

test('the published editor entry registers compiled English messages', () => {
  const i18n = createI18n({ locale: 'en' })
  try {
    expect(
      i18n._({
        id: 'viewer.levels.label',
        message: 'Levels: {mode}',
        values: { mode: 'Stacked' },
      }),
    ).toBe('Levels: Stacked')
  } finally {
    i18n.destroy()
  }
})

function LevelLabel({ level, name }: { level: number; name?: string }) {
  const i18n = usePascalI18n()
  const locale = useLocale()
  return createElement('span', null, localizedLevelName({ level, name }, i18n, locale))
}

test('the published zh-CN host renders numeric storeys without rewriting names', () => {
  registerBundledLocales()
  const i18n = createI18n({ locale: 'zh-CN' })
  const storedLevel = { level: 3, name: 'Floor 3' }
  try {
    const renderLevel = (level: { level: number; name?: string }) =>
      renderToStaticMarkup(
        createElement(PascalI18nProvider, { i18n }, createElement(LevelLabel, level)),
      )

    expect(renderLevel(storedLevel)).toBe('<span>4 层</span>')
    expect(renderLevel({ level: 3, name: 'Floor node-2' })).toBe(
      '<span>Floor node-2</span>',
    )
    expect(storedLevel).toEqual({ level: 3, name: 'Floor 3' })
  } finally {
    i18n.destroy()
  }
})

test('the published scene and host preserve node IDs and authored level names across locales', () => {
  registerBundledLocales()

  const generated = LevelNode.parse({
    id: 'level_locale_generated',
    parentId: 'building_locale_identity',
    level: 3,
    height: 3,
    name: 'Floor 3',
  })
  const authored = LevelNode.parse({
    id: 'level_locale_authored',
    parentId: 'building_locale_identity',
    level: -2,
    height: 3.25,
    name: 'Gallery mezzanine',
  })
  const building = BuildingNode.parse({
    id: 'building_locale_identity',
    parentId: 'site_locale_identity',
    children: [generated.id, authored.id],
  })
  const site = SiteNode.parse({
    id: 'site_locale_identity',
    children: [building.id],
  })
  const persisted: SceneSnapshot = {
    nodes: Object.fromEntries(
      [site, building, generated, authored].map((node) => [node.id, node]),
    ) as SceneSnapshot['nodes'],
    rootNodeIds: [site.id],
    collections: {},
    materials: {},
    installedPlugins: [],
    hasExplicitPluginInstallState: true,
  }

  const environment = createSceneEnvironment('locale-identity')
  const reloadedEnvironment = createSceneEnvironment('locale-identity-reloaded')
  const store = createSceneStore(environment)
  const reloadedStore = createSceneStore(reloadedEnvironment)
  const i18n = createI18n({ locale: 'en' })
  try {
    loadCanonicalSnapshot(store, structuredClone(persisted))
    expect(sceneDocumentOf(store)).toEqual(persisted)

    const renderLevel = (id: typeof generated.id) => {
      const node = sceneDocumentOf(store).nodes[id]
      if (node?.type !== 'level') throw new Error(`Missing level ${id}`)
      return renderToStaticMarkup(
        createElement(
          PascalI18nProvider,
          { i18n },
          createElement(LevelLabel, { level: node.level, name: node.name }),
        ),
      )
    }

    for (const [locale, generatedMarkup] of [
      ['en', '<span>Floor 3</span>'],
      ['zh-CN', '<span>4 层</span>'],
      ['fr', '<span>Étage 3</span>'],
      ['en', '<span>Floor 3</span>'],
    ] as const) {
      i18n.setLocale(locale)
      expect(renderLevel(generated.id)).toBe(generatedMarkup)
      expect(renderLevel(authored.id)).toBe('<span>Gallery mezzanine</span>')
      expect(sceneDocumentOf(store)).toEqual(persisted)
    }

    const saved = JSON.parse(JSON.stringify(sceneDocumentOf(store))) as SceneSnapshot
    expect(saved).toEqual(persisted)
    loadCanonicalSnapshot(reloadedStore, saved)
    const roundTrip = sceneDocumentOf(reloadedStore)
    expect(roundTrip).toEqual(persisted)
    expect(Object.keys(roundTrip.nodes).sort()).toEqual(
      [site.id, building.id, generated.id, authored.id].sort(),
    )
    expect(roundTrip.nodes[generated.id]).toMatchObject({
      id: generated.id,
      parentId: building.id,
      level: 3,
      name: 'Floor 3',
    })
    expect(roundTrip.nodes[authored.id]).toMatchObject({
      id: authored.id,
      parentId: building.id,
      level: -2,
      name: 'Gallery mezzanine',
    })
  } finally {
    i18n.destroy()
    environment.dispose()
    reloadedEnvironment.dispose()
  }
})

test('published URL locales keep server and initial-client level labels in sync', () => {
  registerBundledLocales()

  const generated = { level: 3, name: 'Floor 3' }
  const authored = { level: 3, name: 'Atrium mezzanine' }
  const cases = [
    {
      url: 'https://pascal.example/project/scene?lang=zh-CN',
      locale: 'zh-CN',
      display: '显示设置',
      markup: '<section><span>4 层</span><span>Atrium mezzanine</span></section>',
    },
    {
      url: 'https://pascal.example/project/scene?lang=zh-Hans',
      locale: 'zh-Hans',
      display: '显示设置',
      markup: '<section><span>4 层</span><span>Atrium mezzanine</span></section>',
    },
    {
      url: 'https://pascal.example/project/scene?lang=zh-hans-cn',
      locale: 'zh-Hans-CN',
      display: '显示设置',
      markup: '<section><span>4 层</span><span>Atrium mezzanine</span></section>',
    },
    {
      url: 'https://pascal.example/project/scene?lang=zh-Hant',
      locale: 'zh-Hant',
      display: 'Display settings',
      markup: '<section><span>Floor 3</span><span>Atrium mezzanine</span></section>',
    },
    {
      url: 'https://pascal.example/project/scene?lang=zh-TW',
      locale: 'zh-TW',
      display: 'Display settings',
      markup: '<section><span>Floor 3</span><span>Atrium mezzanine</span></section>',
    },
  ] as const

  const levels = (i18n: ReturnType<typeof createI18n>) =>
    createElement(
      PascalI18nProvider,
      { i18n },
      createElement(
        'section',
        null,
        createElement(LevelLabel, generated),
        createElement(LevelLabel, authored),
      ),
    )

  for (const { url, locale, display, markup } of cases) {
    const requested = new URL(url).searchParams.get('lang')
    if (!requested) throw new Error('Missing requested locale')

    // The standalone request proxy canonicalizes before passing this locale to the client.
    const resolved = Intl.getCanonicalLocales(requested)[0] ?? 'en'
    const serverScope = createI18n({ locale: resolved })
    const clientScope = createI18n({ locale: serverScope.getLocale() })
    try {
      expect(serverScope.getLocale()).toBe(locale)
      expect(clientScope.getLocale()).toBe(locale)

      const title = { id: 'viewer.display.title', message: 'Display settings' }
      expect(serverScope._(title)).toBe(display)
      expect(clientScope._(title)).toBe(display)

      const serverMarkup = renderToString(levels(serverScope))
      const clientInitialMarkup = renderToStaticMarkup(levels(clientScope))
      expect(serverMarkup).toBe(markup)
      expect(clientInitialMarkup).toBe(serverMarkup)
    } finally {
      serverScope.destroy()
      clientScope.destroy()
    }
  }

  expect(generated).toEqual({ level: 3, name: 'Floor 3' })
  expect(authored).toEqual({ level: 3, name: 'Atrium mezzanine' })
})
