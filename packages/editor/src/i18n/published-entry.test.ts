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
import { renderToStaticMarkup } from 'react-dom/server'

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
