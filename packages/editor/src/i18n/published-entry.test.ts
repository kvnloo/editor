import { expect, test } from 'bun:test'
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
