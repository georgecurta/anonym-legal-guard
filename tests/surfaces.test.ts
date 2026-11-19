// Rückübersetzung in der Anzeige nur auf lokalen Oberflächen.
// Aufruf im Ordner des Mods: claude plugin test .  Nichts geht ins Netz.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { mayRevealOnSurface, renderGuarded, sweepKnownDeep, tokenFor, emptyVault, type Entity } from '../hooks/core'

const OPTIONS = { options: { api_key: 'test-key', api_url: 'https://pii.example', allow_other_host: true, ui_language: 'de', language: 'de' } }
const PLUGIN = 'anonym-legal-guard'
const NAME = 'Anna Berg'
const ANY_TOK = /‹[A-Z_]+_\d+·[a-z0-9]{3}›/

function fakeAnalyzer(on: On, status = true) {
  on('http.fetch', (_$, e) => {
    if (!e.url.endsWith('/api/mcp/analyze')) return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    const body = JSON.parse(String(e.init?.body ?? '{}')) as { text: string; language?: string }
    const entities: Entity[] = []
    const at = body.text.indexOf(NAME)
    if (at >= 0) {
      const start = Array.from(body.text.slice(0, at)).length
      entities.push({ entity_type: 'PERSON', start, end: start + Array.from(NAME).length, text: NAME, score: 0.9 })
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ success: true, entities, metadata: { language: body.language } }) } }
  })
  if (status) on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000_000 }))
}

/** Legt NAME in die Zuordnung und gibt den Platzhalter zurück. */
async function tokenOf($: any, on: On, failFirstPlain = false): Promise<string> {
  const session = mock.session(on)
  fakeAnalyzer(on)
  coreDraws(on, failFirstPlain)
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: `Hallo ${NAME}` }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: `u-${Math.random()}`,
  } as never)
  const stored = JSON.stringify(session.appended().at(-1)!.message.content)
  expect(stored.includes(NAME)).toBe(false)
  const token = (stored.match(ANY_TOK) ?? [''])[0]
  expect(token.length > 0).toBe(true)
  return token
}

/** Steht für den Kern: zeichnet den Text, den die Hooks durchreichen, als Text-Element. */
/** Was unter dem Mod ankam, für Bauteile, die nur der Kern der Engine zeichnen darf (AskUserQuestion). */
const reachedCore: string[] = []

function coreDraws(on: On, failFirstPlain = false) {
  let failed = false
  on('ui.render', (_$, e, next) => {
    if (e.component === 'AskUserQuestion') {
      reachedCore.push(`${e.surface}|${JSON.stringify(e.props)}`)
      return next(e)
    }
    const p = e.props as { text?: unknown }
    const text = typeof p.text === 'string' ? p.text : JSON.stringify(p)
    // Steht für einen Fehler im Render-Pfad, nachdem der Mod schon zurückübersetzt hat.
    if (failFirstPlain && !failed && text.includes(NAME)) {
      failed = true
      throw new Error('kaputt')
    }
    return { type: 'Text', props: {}, children: [text] } as never
  })
}

async function drawnOn($: any, surface: string, text: string): Promise<string> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as never)
  const tree = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return tree
}

// ── Reine Regel ──

test('Kern: terminal und desktop zeigen echte Werte; vscode ohne Lokal-Signal nicht; mobile und Unbekanntes nie', () => {
  expect(mayRevealOnSurface('terminal', {})).toBe(true)
  expect(mayRevealOnSurface('desktop', { surfaces: ['desktop'], clients: 1 })).toBe(true)
  expect(mayRevealOnSurface('desktop', { surfaces: ['desktop'] })).toBe(false)
  expect(mayRevealOnSurface('desktop', { surfaces: ['desktop'], clients: 0 })).toBe(true)
  expect(mayRevealOnSurface('desktop', {})).toBe(false)
  expect(mayRevealOnSurface('desktop', { surfaces: ['desktop', 'mobile'] })).toBe(false)
  expect(mayRevealOnSurface('desktop', { surfaces: ['terminal', 'desktop'] })).toBe(false)
  expect(mayRevealOnSurface('desktop', { surfaces: ['desktop'], clients: 2 })).toBe(false)
  expect(mayRevealOnSurface('terminal', { surfaces: ['terminal', 'desktop', 'mobile'], clients: 3 })).toBe(true)
  expect(mayRevealOnSurface('vscode', {})).toBe(false)
  expect(mayRevealOnSurface('vscode', { local: true })).toBe(true)
  expect(mayRevealOnSurface('vscode', { local: false })).toBe(false)
  expect(mayRevealOnSurface('mobile', { local: true })).toBe(false)
  expect(mayRevealOnSurface('web', {})).toBe(false)
  expect(mayRevealOnSurface('', {})).toBe(false)
})

// ── Render-Hook ──

test('Render auf terminal zeigt die echten Werte', OPTIONS, async ($, on) => {
  const token = await tokenOf($, on)
  const tree = await drawnOn($, 'terminal', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(true)
  expect(tree.includes(token)).toBe(false)
})

/** Mountet je Oberfläche eine Antwort und gibt den gezeichneten Baum je Oberfläche zurück. */
async function drawnEach($: any, surfaces: readonly string[], text: string): Promise<Record<string, string>> {
  const shown: Record<string, string> = {}
  for (const surface of surfaces) shown[surface] = await drawnOn($, surface, text)
  return shown
}

/** Die Oberflächen, die `$.session.surfaces()` meldet, und angemeldete Clients. */
function roster(on: On, list: readonly string[]) {
  on('session.surfaces', () => ({ value: list }) as never)
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
}

test('nur desktop angehängt → echte Werte', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  const token = await tokenOf($, on)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' } as never)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(true)
  expect(tree.includes(token)).toBe(false)
})

/**
 * Steht für den Host-Zustand `clients` einer Sitzung, in der der Mod neu geladen wurde: vor dem Laden angemeldete
 * Clients stehen schon im Zustand. Fängt `state.get`/`state.set` für diesen Schlüssel ab.
 */
function clientsBefore(on: On, ids: string[] | 'broken') {
  // Gespeichert wird mit der Form des Atoms: { shape: 'clients-1', value } (gemessen im Test-Kit).
  let stored: unknown = ids === 'broken' ? { shape: 'clients-1', value: 'kaputt' } : { shape: 'clients-1', value: ids }
  let version = 1
  on('state.get', (_$, e, next) => {
    if ((e as { key?: string }).key !== 'clients') return next(e)
    return { value: { value: stored, version } } as never
  })
  on('state.set', (_$, e, next) => {
    if ((e as { key?: string }).key !== 'clients') return next(e)
    stored = (e as { value: unknown }).value
    version++
    return { value: { isSet: true, version } } as never
  })
}

test('neue Sitzung → Client-Liste leer, desktop allein zeigt echte Werte', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  const token = await tokenOf($, on)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(true)
})

test('Neuladen mit zwei zuvor angehängten Clients → desktop Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  clientsBefore(on, ['desktop:a', 'desktop:b'])
  const token = await tokenOf($, on)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(false)
  expect(tree.includes(token)).toBe(true)
})

test('detach nach Neuladen senkt den Zähler: danach desktop echte Werte', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  on('session.detach', (_$, e) => ({ clientId: e.clientId }))
  clientsBefore(on, ['desktop:a', 'desktop:b'])
  const token = await tokenOf($, on)
  expect((await drawnOn($, 'desktop', `Antwort an ${token}`)).includes(NAME)).toBe(false)
  await $.session.detach({ surface: 'desktop', clientId: 'desktop:b', reason: 'detach' } as never)
  expect((await drawnOn($, 'desktop', `Antwort an ${token}`)).includes(NAME)).toBe(true)
})

test('Client-Zähler nicht lesbar → desktop Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  clientsBefore(on, 'broken')
  const token = await tokenOf($, on)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(false)
  expect(tree.includes(token)).toBe(true)
})

test('desktop + mobile → desktop und mobile Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['desktop', 'mobile'])
  const token = await tokenOf($, on)
  const shown = await drawnEach($, ['desktop', 'mobile'], `Antwort an ${token}`)
  for (const s of ['desktop', 'mobile']) {
    expect(shown[s]!.includes(NAME)).toBe(false)
    expect(shown[s]!.includes(token)).toBe(true)
  }
})

test('desktop + desktop (zwei Clients) → Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['desktop'])
  const token = await tokenOf($, on)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:a' } as never)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:b' } as never)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(false)
  expect(tree.includes(token)).toBe(true)
})

test('terminal + desktop → terminal echt, desktop Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['terminal', 'desktop'])
  const token = await tokenOf($, on)
  const shown = await drawnEach($, ['terminal', 'desktop'], `Antwort an ${token}`)
  expect(shown.terminal!.includes(NAME)).toBe(true)
  expect(shown.desktop!.includes(NAME)).toBe(false)
  expect(shown.desktop!.includes(token)).toBe(true)
})

test('terminal, mobile und desktop zugleich: terminal echt, mobile und desktop Platzhalter', OPTIONS, async ($, on) => {
  roster(on, ['terminal', 'mobile', 'desktop'])
  const token = await tokenOf($, on)
  const shown = await drawnEach($, ['terminal', 'mobile', 'desktop'], `Antwort an ${token}`)
  expect(shown.terminal!.includes(NAME)).toBe(true)
  for (const s of ['mobile', 'desktop']) {
    expect(shown[s]!.includes(NAME)).toBe(false)
    expect(shown[s]!.includes(token)).toBe(true)
  }
})

test('surfaces() nicht lesbar → desktop Platzhalter', OPTIONS, async ($, on) => {
  on('session.surfaces', () => {
    throw new Error('kaputt')
  })
  const token = await tokenOf($, on)
  const tree = await drawnOn($, 'desktop', `Antwort an ${token}`)
  expect(tree.includes(NAME)).toBe(false)
  expect(tree.includes(token)).toBe(true)
})

for (const surface of ['mobile', 'vscode', 'desktop'] as const) {
  test(`Render auf ${surface} zeigt Platzhalter, kein Klarwert im Element-Baum`, OPTIONS, async ($, on) => {
    const token = await tokenOf($, on)
    const tree = await drawnOn($, surface, `Antwort an ${token}`)
    expect(tree.includes(NAME)).toBe(false)
    expect(tree.includes(token)).toBe(true)
  })
}

test('terminal und mobile zugleich angehängt: terminal echte Werte, mobile Platzhalter', OPTIONS, async ($, on) => {
  const token = await tokenOf($, on)
  const text = `Antwort an ${token}`
  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as never)
  const phone = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as never)
  const t1 = JSON.stringify(await term.drawn())
  const t2 = JSON.stringify(await phone.drawn())
  expect(t1.includes(NAME)).toBe(true)
  expect(t2.includes(NAME)).toBe(false)
  expect(t2.includes(token)).toBe(true)
  await term.unmount()
  await phone.unmount()
})

test('wirft der Render-Hook intern, bleibt der Platzhalter, kein Klarwert', OPTIONS, async ($, on) => {
  const token = await tokenOf($, on, true)
  const tree = await drawnOn($, 'terminal', `Antwort an ${token}`)
  // Gezeichnet wird, was unter dem Mod steht (hier der Kern der Engine mit dem Original), nie der Klarwert.
  expect(token.length > 0).toBe(true)
  expect(tree.includes(NAME)).toBe(false)
})

// ── /pii ──

test('/pii nennt je Oberfläche, ob rückübersetzt wird, und die Oberfläche mit Platzhaltern', OPTIONS, async ($, on) => {
  fakeAnalyzer(on)
  on('session.surfaces', () => ({ value: ['terminal', 'mobile'] }) as never)
  const text = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(text.includes('Anzeige auf mobile mit Platzhaltern (nicht lokal)')).toBe(true)
  expect(text.includes('terminal: echte Werte')).toBe(true)
  expect(text.includes('mobile: Platzhalter')).toBe(true)
})

test('Statuszeile hängt den Hinweis an, wenn eine Oberfläche Platzhalter zeigt', OPTIONS, async ($, on) => {
  fakeAnalyzer(on, false)
  const status: string[] = []
  on('ui.status', (_$, e) => {
    status.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('session.surfaces', () => ({ value: ['terminal', 'mobile'] }) as never)
  await $.command.run({ command: 'pii' } as never)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(status.some((s) => s.includes('Anzeige auf mobile mit Platzhaltern (nicht lokal)'))).toBe(true)
})

// ── Werkzeugzeilen und Fehlerpfad ──

const TOOL_USE = (input: unknown, output?: unknown) => ({
  tool_use_id: 't1', tool: 'Read', input, isRunning: false, isErrored: false, isInterrupted: false, ...(output === undefined ? {} : { output }),
})

async function toolOn($: any, surface: string, component: 'ToolUse' | 'ToolResult', props: unknown): Promise<string> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component, props } as never)
  const tree = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return tree
}

test('Kern: sweepKnownDeep setzt Klarwerte rekursiv zurück, Unverändertes bleibt dasselbe Objekt', () => {
  const v = tokenFor(emptyVault('abc'), 'PERSON', NAME).vault
  const same = { a: 1, b: ['x', { c: 'y' }] }
  expect(sweepKnownDeep(same, v)).toBe(same)
  const out = sweepKnownDeep({ file_path: '/a.txt', content: [`Kunde ${NAME}`, { deep: NAME }] }, v)
  expect(JSON.stringify(out).includes(NAME)).toBe(false)
  expect(JSON.stringify(out).includes('‹PERSON_1·abc›')).toBe(true)
})

for (const surface of ['mobile', 'desktop', 'vscode'] as const) {
  test(`lokales Werkzeug mit Klarwert in Argument und Ergebnis, auf ${surface}: kein Klarwert im Baum`, OPTIONS, async ($, on) => {
    const token = await tokenOf($, on)
    const use = await toolOn($, surface, 'ToolUse', TOOL_USE({ file_path: '/a.txt', content: `Name: ${NAME}` }, `Kunde ${NAME}`))
    expect(use.includes(NAME)).toBe(false)
    expect(use.includes(token)).toBe(true)
    const result = await toolOn($, surface, 'ToolResult', { tool_use_id: 't1', tool: 'Read', output: { lines: [`Kunde ${NAME}`] }, isErrored: false })
    expect(result.includes(NAME)).toBe(false)
    expect(result.includes(token)).toBe(true)
  })
}

test('Werkzeugzeile auf terminal bleibt wie bisher (echte Werte lokaler Werkzeuge)', OPTIONS, async ($, on) => {
  await tokenOf($, on)
  const use = await toolOn($, 'terminal', 'ToolUse', TOOL_USE({ content: `Name: ${NAME}` }, `Kunde ${NAME}`))
  expect(use.includes(NAME)).toBe(true)
  const result = await toolOn($, 'terminal', 'ToolResult', { tool_use_id: 't1', tool: 'Read', output: `Kunde ${NAME}`, isErrored: false })
  expect(result.includes(NAME)).toBe(true)
})

test('ToolUse auf terminal und mobile zugleich: terminal echte Werte, mobile Platzhalter', OPTIONS, async ($, on) => {
  const token = await tokenOf($, on)
  const props = TOOL_USE({ content: `Name: ${NAME}` }, `Kunde ${NAME}`)
  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolUse', props } as never)
  const phone = await $.ui.mount({ plugin: PLUGIN, surface: 'mobile', component: 'ToolUse', props } as never)
  const t1 = JSON.stringify(await term.drawn())
  const t2 = JSON.stringify(await phone.drawn())
  expect(t1.includes(NAME)).toBe(true)
  expect(t2.includes(NAME)).toBe(false)
  expect(t2.includes(token)).toBe(true)
  await term.unmount()
  await phone.unmount()
})

// Der Fehlerpfad als reine Funktion (wie `safeUi`): im Mod gibt es keinen Schalter, der die Bereinigung werfen lässt.
const fail = () => {
  throw new Error('kaputt')
}

test('Kern: renderGuarded — Bereinigung wirft lokal: genau ein next mit dem Original', async () => {
  const calls: string[] = []
  const r = await renderGuarded({ original: 'orig', reveal: true, prepare: fail, next: (x: string) => (calls.push(x), `drawn:${x}`), withheld: () => 'withheld' })
  expect(calls).toEqual(['orig'])
  expect(r).toBe('drawn:orig')
})

test('Kern: renderGuarded — Bereinigung wirft entfernt: kein next, nur der Hinweis', async () => {
  const calls: string[] = []
  const r = await renderGuarded({ original: `Name ${NAME}`, reveal: false, prepare: fail, next: (x: string) => (calls.push(x), x), withheld: () => 'withheld' })
  expect(calls).toEqual([])
  expect(r).toBe('withheld')
})

test('Kern: renderGuarded — Erfolg: genau ein next mit dem bereinigten Wert', async () => {
  const calls: string[] = []
  await renderGuarded({ original: 'a', reveal: false, prepare: async () => 'b', next: (x: string) => (calls.push(x), x), withheld: () => 'withheld' })
  expect(calls).toEqual(['b'])
})

test('Kern: renderGuarded — scheitert next selbst, wird nicht ein zweites Mal weitergereicht', async () => {
  let calls = 0
  let caught = ''
  try {
    await renderGuarded({
      original: 'a',
      reveal: true,
      prepare: (x: string) => x,
      next: () => {
        calls++
        throw new Error('unten kaputt')
      },
      withheld: () => 'withheld',
    })
  } catch (err) {
    caught = String((err as Error).message)
  }
  expect(calls).toBe(1)
  expect(caught).toBe('unten kaputt')
})

test('AskUserQuestion auf mobile zeigt Platzhalter, auf terminal unverändert', OPTIONS, async ($, on) => {
  const token = await tokenOf($, on)
  const props = { tool: 'AskUserQuestion', questions: [{ question: `Soll ich ${NAME} anschreiben?`, options: [{ label: NAME }] }] }
  // AskUserQuestion zeichnet nur der Kern; geprüft wird, was beim Kern ankommt.
  reachedCore.length = 0
  for (const surface of ['mobile', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AskUserQuestion', props } as never)
    await ui.unmount()
  }
  const phone = reachedCore.find((r) => r.startsWith('mobile|')) ?? ''
  const term = reachedCore.find((r) => r.startsWith('terminal|')) ?? ''
  expect(phone.includes(NAME)).toBe(false)
  expect(phone.includes(token)).toBe(true)
  expect(term.includes(NAME)).toBe(true)
})
