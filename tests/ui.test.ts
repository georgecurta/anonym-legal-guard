// 0.8 Firewall-Seitenleiste (Pane) und Sperr-Band, wertfrei und gedrosselt.
// Aufruf im Ordner des Mods: claude plugin test .  Nichts geht ins Netz.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Entity } from '../hooks/core'
import { bandText, paneModel, PANE_ID, shownHost, shownLanguage, shownLanguages, shownPreset, shownSurface, shownSwitch, shownTypes, type PaneInput } from '../hooks/ui'

const KEY = 'geheim-tok-4711'
const OPTIONS = { options: { api_key: KEY, api_url: 'https://pii.example', allow_other_host: true, ui_language: 'de', language: 'de' } }
const NO_KEY = { options: { ui_language: 'de', language: 'de' } }
const PLUGIN = 'anonym-legal-guard'
const NAME = 'Anna Berg'
const MAIL = 'anna.berg@example.org'
const ANY_TOK = /‹[A-Z_]+_\d+·[a-z0-9]{3}›/

/** Ein Server mit umschaltbarem Status, eine Uhr im Speicher, gezählte eigene `invalidate`-Aufrufe. */
function world(on: On, start = 200, panesOpen = false) {
  const s = { status: start, invalidates: 0, opens: 0, panesOpen }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', (_$, e) => {
    if (!e.url.endsWith('/api/mcp/analyze')) return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    if (s.status >= 300) return { value: { status: s.status, ok: false, headers: {}, text: '{}' } }
    const b = JSON.parse(String(e.init?.body ?? '{}')) as { text: string; language?: string }
    const entities: Entity[] = []
    for (const [needle, type] of [[NAME, 'PERSON'], [MAIL, 'EMAIL_ADDRESS']] as const) {
      const at = b.text.indexOf(needle)
      if (at >= 0) {
        const from = Array.from(b.text.slice(0, at)).length
        entities.push({ entity_type: type, start: from, end: from + Array.from(needle).length, text: needle, score: 0.9 })
      }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ success: true, entities, metadata: { language: b.language } }) } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => {
    s.invalidates++
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: s.panesOpen ? [{ id: PANE_ID, title: 'anonym.legal Firewall', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  return { s, clock }
}

function row(text: string) {
  return {
    message: { type: 'user' as never, role: 'user' as const, content: [{ type: 'text', text }] as never },
    door: 'prompt' as never,
    origin: { kind: 'composer' } as never,
    uuid: `u-${Math.random()}`,
  }
}

async function draw($: any, surface: string, component: 'Pane' | 'AbovePrompt'): Promise<string> {
  const props =
    component === 'Pane'
      ? { title: 'anonym.legal Firewall', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }
      : { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 } }
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component, props, ...(component === 'Pane' ? { requestId: PANE_ID } : {}) } as never)
  const tree = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return tree
}

const clean = (tree: string) =>
  !tree.includes(NAME) && !tree.includes('Anna') && !tree.includes(MAIL) && !tree.includes(KEY) && !ANY_TOK.test(tree)

// ── Reine Funktionen ──

const BASE: PaneInput = {
  lang: 'de',
  status: { state: 'protected', httpStatus: 200 },
  check: { status: 200, at: Date.UTC(2026, 10, 19, 9, 5, 7) },
  languages: 'Sprache de',
  replaced: 3,
  counter: { PERSON: 2, EMAIL_ADDRESS: 1 },
  blocked: 1,
  leaks: 2,
  withheld: 4,
  inWindow: 7,
  limit: 540,
  surfaces: [
    { name: 'terminal', placeholders: false },
    { name: 'mobile', placeholders: true },
  ],
}

test('paneModel — Grenzen zuerst, Zustand mit Symbol, Prüfung, Zähler je Typ, Oberflächen, Fußzeile', () => {
  const m = paneModel(BASE)
  expect(m.title).toBe('anonym.legal Firewall')
  expect(m.lines[0]).toBe('Schutz gegen Versehen, nicht gegen eingeschleuste Anweisungen und nicht gegen Absicht.')
  const all = m.lines.join('\n')
  expect(all.includes('🛡 Zustand: geschützt')).toBe(true)
  expect(all.includes('09:05:07 UTC')).toBe(true)
  expect(all.includes('HTTP 200')).toBe(true)
  expect(all.includes('Sprache de')).toBe(true)
  expect(all.includes('3 ersetzt')).toBe(true)
  expect(all.includes('PERSON 2')).toBe(true)
  expect(all.includes('EMAIL_ADDRESS 1')).toBe(true)
  expect(all.includes('mobile: Platzhalter')).toBe(true)
  expect(all.includes('7 von 540')).toBe(true)
  expect(m.footer.hotkey).toBe('r')
  expect(m.footer.close).toBe('Esc schließt · /pii')
  expect(m.footer.focus).toBe('im Fokus (Klick/ctrl+x tab):')
})

test('paneModel — Symbole und nächster Schritt je Zustand', () => {
  expect(paneModel({ ...BASE, status: { state: 'checking' }, check: undefined }).lines.join('\n').includes('⏳')).toBe(true)
  const failing = paneModel({ ...BASE, status: { state: 'failing', reason: 'unauthorized', httpStatus: 401 } }).lines.join('\n')
  expect(failing.includes('⚠ Zustand: zurückgehalten (Token ungültig).')).toBe(true)
  expect(failing.includes('Neuen Token unter https://anonym.legal/app/settings?tab=developer')).toBe(true)
  const unset = paneModel({ ...BASE, lang: 'en', status: { state: 'unset', reason: 'no_key' }, check: undefined }).lines.join('\n')
  expect(unset.includes('○ State: not set up')).toBe(true)
  expect(unset.includes('Last check: none')).toBe(true)
})

test('bandText nur bei failing und unset, mit Grund und nächstem Schritt', () => {
  expect(bandText({ state: 'protected' }, 'de')).toBe(undefined)
  expect(bandText({ state: 'checking' }, 'de')).toBe(undefined)
  const f = String(bandText({ state: 'failing', reason: 'payment' }, 'de'))
  expect(f.includes('Guthaben aufgebraucht')).toBe(true)
  expect(f.includes('https://anonym.legal/app/billing')).toBe(true)
  const u = String(bandText({ state: 'unset', reason: 'no_key' }, 'en'))
  expect(u.includes('no API token')).toBe(true)
  expect(u.includes('Configure')).toBe(true)
})

// ── Pane ──

test('Pane zeigt Zustand und Zähler je Typ nach zwei ersetzten Werten', OPTIONS, async ($, on) => {
  world(on)
  await $.session.append(row(`Hallo ${NAME}, Mail ${MAIL}`) as never)
  const tree = await draw($, 'terminal', 'Pane')
  expect(tree.includes('geschützt')).toBe(true)
  expect(tree.includes('2 ersetzt')).toBe(true)
  expect(tree.includes('PERSON 1')).toBe(true)
  expect(tree.includes('EMAIL_ADDRESS 1')).toBe(true)
})

for (const surface of ['terminal', 'mobile'] as const) {
  test(`Pane und Band auf ${surface} enthalten nie einen Klarwert oder Token`, OPTIONS, async ($, on) => {
    const { s } = world(on)
    await $.session.append(row(`Hallo ${NAME}, Mail ${MAIL}`) as never)
    const pane = await draw($, surface, 'Pane')
    expect(pane.includes('PERSON')).toBe(true) // Muss-Treffer: die Pane ist gezeichnet
    expect(clean(pane)).toBe(true)
    s.status = 401
    await $.prompt.submit({ text: `Nochmal ${NAME}` } as never)
    const band = await draw($, surface, 'AbovePrompt')
    expect(band.includes('Token ungültig')).toBe(true) // Muss-Treffer: das Band ist gezeichnet
    expect(clean(band)).toBe(true)
    expect(clean(await draw($, surface, 'Pane'))).toBe(true)
  })
}

// ── Band ──

test('Band erscheint bei failing, verschwindet bei protected', OPTIONS, async ($, on) => {
  const { s } = world(on, 500)
  const r = await $.prompt.submit({ text: 'Hallo Welt' } as never)
  expect('drop' in r).toBe(true)
  expect((await draw($, 'terminal', 'AbovePrompt')).includes('Serverfehler')).toBe(true)
  s.status = 200
  await $.session.append(row(`Hallo ${NAME}`) as never)
  const after = await draw($, 'terminal', 'AbovePrompt')
  expect(after.includes('anonym.legal')).toBe(false)
})

test('Band erscheint bei unset (kein Token)', NO_KEY, async ($, on) => {
  world(on)
  const band = await draw($, 'terminal', 'AbovePrompt')
  expect(band.includes('kein API-Token')).toBe(true)
  expect(band.includes('Configure')).toBe(true)
})

// ── Drosselung ──

test('10 Aktualisierungen in einer Sekunde ergeben höchstens 2 eigene invalidate', OPTIONS, async ($, on) => {
  const { s, clock } = world(on, 200, true)
  await $.session.append(row('Erste Zeile ohne Namen, aber lang genug') as never)
  await clock.advance(2000)
  s.invalidates = 0
  for (let i = 0; i < 10; i++) {
    await $.session.append(row(`Zeile ${i} mit ${NAME} und genug Text`) as never)
    await clock.advance(50)
  }
  await clock.advance(1500)
  expect(s.invalidates >= 1).toBe(true)
  expect(s.invalidates <= 2).toBe(true)
})

test('ohne offene Pane und ohne Bandwechsel kein invalidate', OPTIONS, async ($, on) => {
  const { s, clock } = world(on, 200, false)
  await $.session.append(row('Erste Zeile ohne Namen, aber lang genug') as never)
  await clock.advance(2000)
  s.invalidates = 0
  for (let i = 0; i < 5; i++) await $.session.append(row(`Zeile ${i} mit ${NAME} und genug Text`) as never)
  await clock.advance(1500)
  expect(s.invalidates).toBe(0)
})

// ── /pii und Fehlerpfade ──

test('/pii öffnet die Pane; liefert open isPlaced:false, bleibt der Text unverändert', OPTIONS, async ($, on) => {
  const { s } = world(on)
  on('ui.open', (_$, e) => {
    s.opens++
    expect((e as { id: string }).id).toBe(PANE_ID)
    return { value: { isPlaced: false, reason: 'narrow' } } as never
  })
  const text = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(s.opens).toBe(1)
  expect(text.startsWith('Schutz gegen Versehen')).toBe(true)
  expect(text.includes('Zustand: geschützt')).toBe(true)
})

test('wirft die UI (open, panes, invalidate, status), wird der Prompt trotzdem geschwärzt gesendet', OPTIONS, async ($, on) => {
  const session = mock.session(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', (_$, e) => {
    const b = JSON.parse(String(e.init?.body ?? '{}')) as { text: string; language?: string }
    const at = b.text.indexOf(NAME)
    const entities = at >= 0 ? [{ entity_type: 'PERSON', start: at, end: at + NAME.length, text: NAME, score: 0.9 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ success: true, entities, metadata: { language: b.language } }) } }
  })
  on('ui.log', () => ({ value: undefined }))
  for (const ev of ['ui.status', 'ui.open', 'ui.panes', 'ui.invalidate'] as const) {
    on(ev as never, (() => {
      throw new Error(`${ev} kaputt`)
    }) as never)
  }
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.command.run({ command: 'pii' } as never)
  const r = await $.prompt.submit({ text: `Hallo ${NAME}` } as never)
  expect('drop' in r).toBe(false)
  await $.session.append(row(`Hallo ${NAME}`) as never)
  const stored = JSON.stringify(session.appended().at(-1)!.message.content)
  expect(stored.includes(NAME)).toBe(false)
  expect(ANY_TOK.test(stored)).toBe(true)
})

// ── fremdgesteuerte Texte, Drosselung mit spätem Zeitgeber ──

test('Korrektur 1 Kern: nur feste Typen, Sprachcodes und Oberflächen werden angezeigt', () => {
  expect(shownTypes({ PERSON: 2, ANNA_BERG: 1, 'X Y': 2 }, 'de')).toBe('PERSON 2, Andere 3')
  expect(shownTypes({ ANNA_BERG: 1 }, 'en')).toBe('other 1')
  expect(shownTypes({}, 'de')).toBe('keine')
  expect(shownLanguages(['de', 'EN', 'pt-br', 'Anna Berg', 'anna', 'zz', 'aa-BB', 'account'], 'de')).toEqual(['de', 'en', 'account', 'andere'])
  expect(shownLanguages(['zz'], 'en')).toEqual(['other'])
  expect(shownLanguages(['aa-BB'], 'de')).toEqual(['andere'])
  expect(shownSurface('mobile', 'de')).toBe('mobile')
  expect(shownSurface('Anna Berg', 'de')).toBe('unbekannte Oberfläche')
  const m = paneModel({ ...BASE, counter: { ANNA_BERG: 1 }, surfaces: [{ name: 'Anna Berg', placeholders: true }] }).lines.join('\n')
  expect(m.includes('Anna')).toBe(false)
  expect(m.includes('ANNA')).toBe(false)
  expect(m.includes('Andere 1')).toBe(true)
  expect(m.includes('unbekannte Oberfläche: Platzhalter')).toBe(true)
})

const ACCOUNT = { options: { api_key: KEY, api_url: 'https://pii.example', allow_other_host: true, ui_language: 'de', language: 'account' } }

test('Korrektur 1: bösartiger entity_type, Sprachcode und Oberflächenname erscheinen nirgends (Pane, Band, Statuszeile, /pii)', ACCOUNT, async ($, on) => {
  const st = { status: 200 }
  const statuses: string[] = []
  mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', (_$, e) => {
    if (!e.url.endsWith('/api/mcp/analyze')) return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    if (st.status >= 300) return { value: { status: st.status, ok: false, headers: {}, text: '{}' } }
    const b = JSON.parse(String(e.init?.body ?? '{}')) as { text: string }
    const at = b.text.indexOf(NAME)
    const entities = at >= 0 ? [{ entity_type: 'Anna Berg', start: at, end: at + NAME.length, text: NAME, score: 0.9 }] : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ success: true, entities, metadata: { languages_used: ['de', 'Anna Berg'] } }) } }
  })
  on('session.surfaces', () => ({ value: ['terminal', 'Anna Berg'] }) as never)
  on('ui.status', (_$, e) => {
    statuses.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  const bad = (x: string) => /anna|berg/i.test(x)
  await $.session.append(row(`Hallo ${NAME}`) as never)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Andere 1')).toBe(true) // Muss-Treffer: der Zähler ist da
  expect(pii.includes('unbekannte Oberfläche')).toBe(true)
  expect(bad(pii)).toBe(false)
  for (const surface of ['terminal', 'mobile'] as const) {
    const pane = await draw($, surface, 'Pane')
    expect(pane.includes('Andere 1')).toBe(true)
    expect(bad(pane)).toBe(false)
  }
  st.status = 401
  await $.prompt.submit({ text: 'Hallo Welt, noch einmal' } as never)
  for (const surface of ['terminal', 'mobile'] as const) {
    const band = await draw($, surface, 'AbovePrompt')
    expect(band.includes('Token ungültig')).toBe(true)
    expect(bad(band)).toBe(false)
  }
  expect(statuses.length > 0).toBe(true)
  expect(statuses.some(bad)).toBe(false)
})

test('Korrektur 1: der Zeitgeber der Drosselung prüft die Pane erneut; zu ist sie, kein invalidate', OPTIONS, async ($, on) => {
  const { s, clock } = world(on, 200, true)
  await $.session.append(row('Erste Zeile ohne Namen, aber lang genug') as never)
  await clock.advance(100)
  s.invalidates = 0
  // Innerhalb der Sekunde: das Neuzeichnen wird über den Zeitgeber bestellt.
  await $.session.append(row(`Zeile mit ${NAME} und genug Text`) as never)
  await clock.settle() // die Bestellung ist aufgegeben: der Zeitgeber steht
  expect(s.invalidates).toBe(0)
  // Die Person schließt die Pane, bevor der Zeitgeber feuert.
  s.panesOpen = false
  await clock.advance(5000)
  expect(s.invalidates).toBe(0)
  // Gegenprobe: offen, und der verspätete Zeitgeber zeichnet genau einmal.
  s.panesOpen = true
  await $.session.append(row(`Noch eine Zeile mit ${NAME} und Text`) as never)
  await clock.advance(5000)
  expect(s.invalidates).toBe(1)
  // Die Sekunde gilt ab dem tatsächlichen Neuzeichnen (frische Zeit): sofort danach wird wieder gebündelt.
  await $.session.append(row(`Dritte Zeile mit ${NAME} und Text`) as never)
  expect(s.invalidates).toBe(1)
  await clock.advance(1500)
  expect(s.invalidates).toBe(2)
})

// ── Fehlertexte, Sprachen des Servers, Dateipfade ──

test('Korrektur 2: ein fremder Fehlertext mit Klarwert erscheint nicht (Sperrmeldung, /pii, Statuszeile, Pane)', OPTIONS, async ($, on) => {
  const statuses: string[] = []
  mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', () => {
    throw new Error(`connect failed for ${NAME} <${MAIL}>`)
  })
  on('ui.status', (_$, e) => {
    statuses.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  const bad = (x: string) => /anna|berg/i.test(x)
  const r = await $.prompt.submit({ text: 'Hallo Welt' } as never)
  expect('drop' in r && String(r.drop).includes('Netzwerkfehler')).toBe(true) // Muss-Treffer: die Kategorie
  expect(bad(String((r as { drop?: string }).drop))).toBe(false)
  await $.session.append(row('Eine Zeile, die geprüft werden soll') as never)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Letzter Fehler: Netzwerkfehler')).toBe(true)
  expect(bad(pii)).toBe(false)
  expect(bad(await draw($, 'mobile', 'Pane'))).toBe(false)
  expect(bad(await draw($, 'terminal', 'AbovePrompt'))).toBe(false)
  expect(statuses.some(bad)).toBe(false)
})

test('Korrektur 2: Sprachen aus Serverantworten (503 MODEL_LOADING, 400 unsupported) nur aus der festen Liste', { options: { ...OPTIONS.options, language: 'de' } }, async ($, on) => {
  const st = { body: '' as string, status: 503 }
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('http.fetch', () => ({ value: { status: st.status, ok: false, headers: {}, text: st.body } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  st.body = JSON.stringify({ error: 'MODEL_LOADING', language: 'Anna Berg' })
  // 503 wird wiederholt: die Pausen laufen über die Uhr im Speicher.
  const p1 = $.prompt.submit({ text: 'Hallo Welt' } as never)
  for (let i = 0; i < 10; i++) await clock.advance(1000)
  const d1 = String(((await p1) as { drop?: string }).drop)
  expect(d1.includes('Sprachmodell lädt noch')).toBe(true)
  expect(/anna/i.test(d1)).toBe(false)
  st.status = 400
  st.body = JSON.stringify({ error: 'UNSUPPORTED_LANGUAGE', unsupported: ['de', 'zz', 'Anna Berg'] })
  const d2 = String(((await $.prompt.submit({ text: 'Hallo nochmal' } as never)) as { drop?: string }).drop)
  expect(d2.includes('Sprache de, andere wird vom Server nicht unterstützt')).toBe(true)
  expect(/anna|zz/i.test(d2)).toBe(false)
})

test('Korrektur 2: /pii nennt markierte Dateien nur als Anzahl, nie den Pfad', OPTIONS, async ($, on) => {
  world(on)
  const session = mock.session(on)
  on('tool.call', () => ({ result: {} as never }))
  await $.session.append(row(`Kunde ${NAME}`) as never)
  const token = (JSON.stringify(session.appended().at(-1)!.message.content).match(ANY_TOK) ?? [''])[0]
  expect(token.length > 0).toBe(true)
  await $.tool.call({ tool: 'Write', file_path: '/akten/akte-berg.txt', content: `Name: ${token}` })
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Markierte Dateien: 1')).toBe(true)
  expect(/berg|akte/i.test(pii)).toBe(false)
  expect(/berg|akte/i.test(await draw($, 'terminal', 'Pane'))).toBe(false)
})

// ── Konfigurationswerte nur aus festen Listen ──

test('Korrektur 3 Kern: Host, Preset und Sprache aus der Konfiguration nur aus festen Listen', () => {
  expect(shownHost('https://anonym.legal', 'de')).toBe('anonym.legal')
  expect(shownHost('https://anna-berg.example', 'de')).toBe('eigener Host (allow_other_host)')
  expect(shownHost('kaputt', 'en')).toBe('own host (allow_other_host)')
  expect(shownPreset('developer', 'de')).toBe('developer')
  expect(shownPreset('akte-berg', 'de')).toBe('eigenes')
  expect(shownLanguage('zz', 'de')).toBe('andere')
  expect(shownLanguage('de', 'de')).toBe('de')
})

test('Korrektur 3: /pii und Pane zeigen keine URL, kein eigenes Preset und keinen unbekannten Sprachcode', { options: { ...OPTIONS.options, api_url: 'https://anna-berg.example', language: 'de,zz', preset: 'akte-berg' } }, async ($, on) => {
  world(on)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('eigener Host (allow_other_host)')).toBe(true) // Muss-Treffer
  expect(pii.includes('Voreinstellung eigenes')).toBe(true)
  expect(pii.includes('Sprache de+andere')).toBe(true)
  expect(/anna|berg|akte|\bzz\b|example/i.test(pii)).toBe(false)
  const pane = await draw($, 'terminal', 'Pane')
  expect(pane.includes('de+andere')).toBe(true)
  expect(/anna|berg|\bzz\b|example/i.test(pane)).toBe(false)
})

test('Korrektur 3: ein bekanntes Preset steht beim Namen', { options: { ...OPTIONS.options, preset: 'developer' } }, async ($, on) => {
  world(on)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Voreinstellung developer')).toBe(true)
})

test('Korrektur 3: eine fremde api_url ohne allow_other_host: die Sperrmeldung nennt den Host nicht', { options: { api_key: KEY, ui_language: 'de', language: 'de', api_url: 'https://anna-berg.example' } }, async ($, on) => {
  world(on)
  const r = await $.prompt.submit({ text: 'Hallo Welt' } as never)
  const drop = String((r as { drop?: string }).drop)
  expect(drop.includes('zeigt nicht auf anonym.legal')).toBe(true)
  expect(/anna|berg|example/i.test(drop)).toBe(false)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(/anna|berg|example/i.test(pii)).toBe(false)
})

// ── Abschluss-Korrektur: gespeicherte Altwerte und Schalter nur als feste Codes ──

test('Abschluss: ein Altbestand in statsAtom (warm/lastError mit freiem Text) erscheint in /pii nur als „unbekannt“', OPTIONS, async ($, on) => {
  world(on)
  const legacy = { scanned: 3, withheld: 1, leaks: 0, blocked: 0, warm: { de: 'Anna Berg', account: 'bereit: Anna Berg' }, lastError: `Fehler bei ${NAME}` }
  on('state.get', (_$, e, next) => (String((e as { key?: unknown }).key) === 'stats' ? ({ value: { value: { shape: 'stats-2', value: legacy }, version: 1 } } as never) : next(e)))
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Vorwärmen: de unbekannt · account unbekannt')).toBe(true) // Muss-Treffer
  expect(pii.includes('Letzter Fehler: unbekannt')).toBe(true)
  expect(/anna|berg/i.test(pii)).toBe(false)
})

test('Abschluss: Vorwärmen speichert feste Codes; /pii zeigt daraus den Text', OPTIONS, async ($, on) => {
  const saved: unknown[] = []
  world(on)
  on('state.set', (_$, e, next) => {
    if (String((e as { key?: unknown }).key) === 'stats') saved.push((e as { value?: unknown }).value)
    return next(e)
  })
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('Vorwärmen: de bereit')).toBe(true)
  const warm = saved.map((v) => (v as { value?: { warm?: Record<string, string> } }).value?.warm).filter(Boolean).at(-1)
  expect(warm).toEqual({ de: 'ready' })
})

test('Abschluss Kern: unbekannte Schalterwerte werden „unbekannt“ (die Engine lässt nur die Optionen aus plugin.json durch)', () => {
  expect(shownSwitch('shell_guard', 'Anna Berg', 'de')).toBe('unbekannt')
  expect(shownSwitch('encoded_runs', 'x1', 'en')).toBe('unknown')
  expect(shownSwitch('leak_guard', 'akte-berg', 'de')).toBe('unbekannt')
  expect(shownSwitch('file_values', 'berg', 'de')).toBe('unbekannt')
  expect(shownSwitch('file_values', 'deny', 'de')).toBe('deny')
})

test('Abschluss: bekannte Schalterwerte stehen beim Namen', { options: { ...OPTIONS.options, shell_guard: 'ask', encoded_runs: 'strict', leak_guard: 'log', file_values: 'deny' } }, async ($, on) => {
  world(on)
  const pii = String((await $.command.run({ command: 'pii' } as never)).text)
  expect(pii.includes('shell_guard ask · encoded_runs strict · leak_guard log · file_values deny')).toBe(true)
})
