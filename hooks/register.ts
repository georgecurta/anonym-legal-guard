// anonym.legal PII-Schutzschicht für Claude Code (v0.9: /pii-setup, Hinweis bei einer Absage, Wächter für die eigenen Optionen).
//
// Was der Mod tut:
//   1. session.append: jede Zeile, die gespeichert und ans Modell geschickt wird, geht vorher
//      durch die Erkennung von anonym.legal; Treffer werden zu Platzhaltern ‹TYP_n·tag›.
//   2. prompt.submit: der Prompt wird vorab geprüft; scheitert die Prüfung, geht er nicht raus.
//      Dazu ein Hinweis fürs Modell, dass Platzhalter gewollt sind.
//   3. prompt.context / prompt.attachment / prompt.section / session.send / session.compact:
//      dieselbe Schwärzung für Kontextblöcke, eingefügte Nachrichten, Abschnitte des
//      System-Prompts mit Umgebungsdaten, Nachrichten an Agenten und /compact-Anweisungen.
//   4. tool.call: lokale Werkzeuge bekommen die echten Werte zurück, Werkzeuge nach außen nicht.
//   5. ui.render: der Mensch liest Klartext, gespeichert und gesendet wird der Platzhalter.
//   6. http.fetch: jede Anfrage ans Modell wird nach bekannten Originalwerten durchsucht; ein
//      eindeutiges Leck stoppt sie (Standard `block`).
//
// Scheitert etwas, wird zurückgehalten, nicht durchgelassen (fail closed), auch im `.catch`.
// Nicht abgedeckt: `gitStatus` (Claude Code sendet es selbst), Bilder im Prompt (nur abweisbar),
// Treffer der API-eigenen Websuche. Siehe README (Limits).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardStats, Vault } from '../types'
import {
  apiUrlProblem,
  applyEntities,
  chunks,
  dedupe,
  detokenize,
  detokenizeDeep,
  emptyVault,
  setAliasDeny,
  encodedNameHit,
  encodedPlan,
  findLeak,
  isAccountOption,
  isTokenCountRequest,
  requestLeak,
  scrubRequestBody,
  insideAllowed,
  insideWord,
  leftoverTokens,
  newTag,
  parseLanguages,
  plausible,
  rateWindow,
  replaceSpans,
  rowIsScanned,
  RUN_SEPARATOR,
  shellVerdict,
  runsWithHits,
  sweepKnown,
  worthScanning,
  deriveStatus,
  reasonOf,
  safeUi,
  ownCommandText,
  ownOptionChange,
  setupErrorResolved,
  TOAST_KINDS,
  TOAST_WINDOW_MS,
  type RefuseKind,
  mayRevealOnSurface,
  sweepKnownDeep,
  renderGuarded,
  type DerivedStatus,
  type GuardReason,
  type SurfaceSignals,
  type Entity,
  type LastCheck,
} from './core'
import { msg, parseLang, type Key, type Lang } from './messages'
import { settingsReport, setupOptionsText, setupPlan, setupQuestions, setupStateText, setupTokenText } from './settings'
import { bandKey, bandText, knownLanguage, paneModel, PANE_ID, PANE_TITLE, shownHost, shownLanguage, shownLanguages, shownPreset, shownSurface, shownSwitch, shownToken, shownTypes, type PaneInput } from './ui'

type Block = { type: string; [field: string]: unknown }

/** Fassung des Mods; muss zu `.claude-plugin/plugin.json` passen (der Mod liest keine Dateien). */
export const VERSION = '0.9.0'
const CLIENT = `ClaudeCodeMod/${VERSION}`

/**
 * Ladung (0.8): jede `register()` bekommt eine neue Generation. `lastCheck` lebt im Modul, nicht im
 * Zustand (`statsAtom` überlebt Neuladen und `--resume`): eine Prüfung einer früheren Ladung zählt nie.
 * Antworten auf Anfragen, die in einer früheren Ladung begannen, werden verworfen.
 */
let gen = 0
let lastCheck: LastCheck | undefined

/**
 * Ein Fehler mit dem Ausgang der Anfrage: HTTP-Code, `net` oder `timeout`, dazu die Zeit der Anfrage und,
 * bei einer Sprache, die der Server nicht geprüft hat, der Grund `language`. Eigene Grenzen tragen keinen.
 */
type CheckError = Error & { checkStatus?: number | 'net' | 'timeout'; checkAt?: number; checkReason?: GuardReason }
/**
 * Fehler, deren Text der Mod selbst aus festen Meldungen baut (Parameter nur aus festen Listen oder der
 * eigenen Konfiguration). Nur deren Text wird angezeigt; jeder andere Fehler (Netz, Engine, Ausnahme)
 * erscheint nur als Kategorie: ein fremder Fehlertext kann einen Klarwert tragen.
 */
const OWN = new WeakMap<Error, string>()
function ownError(message: string, code = 'other'): Error {
  const e = new Error(message)
  OWN.set(e, code)
  return e
}

/** Eigene Fehler, die als fester Code gespeichert werden; ihre Texte baut `codeText` neu. */
const OWN_CODES = new Set(['accountUnsupported', 'accountEmpty', 'noKey', 'noValidLang', 'rateLimit', 'url'])

/**
 * Ein Fehler als fester Code für den gespeicherten Zustand (`statsAtom`: `warm`, `lastError`): nie Text.
 * Codes: `own:<Schlüssel>`, `lang`, `net`, `timeout`, `http:<Zahl>`, `unknown`.
 */
function storedCode(err: unknown): string {
  const own = err instanceof Error ? OWN.get(err) : undefined
  if (own && OWN_CODES.has(own)) return `own:${own}`
  const e = err as CheckError | undefined
  if (e?.checkReason === 'language') return 'lang'
  if (e?.checkStatus === 'net') return 'net'
  if (e?.checkStatus === 'timeout') return 'timeout'
  if (typeof e?.checkStatus === 'number') return `http:${e.checkStatus}`
  return 'unknown'
}

/** Der Text zu einem HTTP-Code, wie `failure` ihn nennt, ohne Antwortkörper. */
function httpText(status: number): string {
  if (status === 401) return t('http401')
  if (status === 402) return t('http402')
  if (status === 403) return t('http403')
  if (status === 429) return t('http429')
  return t('httpOther', { status })
}

/**
 * Der Text zu einem gespeicherten Code; `key` ist die Sprache des Vorwärmens. Was kein bekannter Code ist
 * (auch Altbestand aus 0.7.x mit freiem Text), wird „unbekannt“.
 */
function codeText(code: unknown, key = ''): string {
  const c = typeof code === 'string' ? code : ''
  if (c === 'ready') return t('warmReady')
  if (c.startsWith('ready:')) return t('warmReadyAccount', { langs: shownLanguages(c.slice(6).split(',').filter(Boolean), cfg.lang).join(',') })
  if (c === 'lang') return key && key !== 'account' ? t('langUnsupported', { language: shownLanguage(key, cfg.lang) }) : t('reason_language')
  if (c === 'net') return t('errNetwork')
  if (c === 'timeout') return t('timeout', { s: TIMEOUT_MS / 1000 })
  const http = /^http:(\d{3})$/.exec(c)
  if (http) return httpText(Number(http[1]))
  if (c === 'own:url') return cfg.urlProblem ?? t('unknown')
  if (c === 'own:rateLimit') return t('rateLimit', { limit: RATE_LIMIT, wait: '–' })
  if (c.startsWith('own:') && OWN_CODES.has(c.slice(4))) return t(c.slice(4) as Key)
  if (c === 'unknown') return t('errUnknown')
  return t('unknown')
}

/** Was von einem Fehler angezeigt wird: der eigene Text oder eine Kategorie (Netz, Zeitgrenze, HTTP, unbekannt). */
function shownError(err: unknown): string {
  if (err instanceof Error && OWN.has(err)) return err.message
  const status = (err as CheckError | undefined)?.checkStatus
  if (status === 'net') return t('errNetwork')
  if (status === 'timeout') return t('timeout', { s: TIMEOUT_MS / 1000 })
  if (typeof status === 'number') return t('httpOther', { status })
  return t('errUnknown')
}

const tagged = (err: unknown, status: number | 'net' | 'timeout'): CheckError => {
  const e = (err instanceof Error ? err : new Error(String(err))) as CheckError
  e.checkStatus ??= status
  return e
}

const vaultAtom = atom({ plugin: 'anonym-legal-guard', key: 'vault' } as const, emptyVault(), { shape: 'vault-3' })
const statsAtom = atom({ plugin: 'anonym-legal-guard', key: 'stats' } as const, { scanned: 0, withheld: 0, leaks: 0, blocked: 0 } as GuardStats, {
  shape: 'stats-2',
})

/**
 * Angemeldete Clients (clientIds) dieser Sitzung, für `desktop`. Ein `$.state`-Atom: der Host hält es
 * für die Sitzung, es überlebt ein Neuladen des Mods und wird beim Laden NICHT geleert; eine neue Sitzung beginnt leer.
 */
const clientsAtom = atom({ plugin: 'anonym-legal-guard', key: 'clients' } as const, [] as string[], { shape: 'clients-1' })

const taintedAtom = atom({ plugin: 'anonym-legal-guard', key: 'tainted' } as const, [] as string[], { shape: 'tainted-1' })

/**
 * Eigene Grenze des Mods: Ab 540 Anfragen im 5-Minuten-Fenster geht keine mehr hinaus, die Zeile wird
 * zurückgehalten.
 */
const RATE_LIMIT = 540
const RATE_WINDOW = 5 * 60 * 1000
let sent: number[] = []

/** Höchstens so viele Codepunkte je Anfrage an die Erkennung mit Überlappung. */
const CHUNK = 50_000
const OVERLAP = 400
/** Zwischenspeicher: derselbe Text wird nur einmal geprüft (Prompt, dann seine Zeile). */
const CACHE_MAX = 200

/** Eine Meldung in der Sprache dieser Ladung (Option `ui_language`). */
const t = (key: Key, params?: Record<string, string | number>) => msg(cfg.lang, key, params)
/** Beide Fassungen des Hinweises fürs Modell: eine Sitzung kann mit anderer Sprache fortgesetzt werden. */
const hints = () => [...new Set([t('hint'), msg('en', 'hint'), msg('de', 'hint')])]

/** Felder, die die Engine setzt; sie werden nie umgeschrieben. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
/** Abschnitte des System-Prompts, die Umgebungsdaten tragen (Arbeitsordner mit Benutzername, Notizen). */
const SECTIONS = /^(env_info|memory)/

type Config = {
  apiUrl: string
  /** Warum die Adresse nicht benutzt wird; dann geht keine Anfrage hinaus und jeder Prompt wird verworfen. */
  urlProblem?: string
  apiKey: string
  /** Sprache der Meldungen */
  lang: Lang
  /** Kontomodus: keine Sprache im Körper, der Server nimmt die des Kontos */
  account: boolean
  languages: string[]
  preset: string
  leakGuard: string
  encodedRuns: string
  shellGuard: string
  fileValues: string
  media: string
  detokenizeBash: boolean
  minScore: number
  ignoreTypes: Set<string>
  scanHookContext: boolean
  skipAttachments: Set<string>
  allowValues: Set<string>
  cache: Map<string, Entity[]>
}

/** Die Optionen dieser Ladung; `register` setzt sie bei jedem Laden neu. */
let cfg: Config = {
  apiUrl: 'https://anonym.legal', apiKey: '', lang: 'en', account: true, languages: [], preset: '', leakGuard: 'block', encodedRuns: 'scan', shellGuard: 'block', fileValues: 'real', media: 'drop',
  detokenizeBash: false, minScore: 0.5, ignoreTypes: new Set(), scanHookContext: true, skipAttachments: new Set(), allowValues: new Set(), cache: new Map(),
}

/**
 * Anhänge, die Claude Code selbst schreibt und die keine Kundendaten tragen: Werkzeug-, Skill- und
 * Agentenlisten, MCP-Anweisungen, Modell, Datum. Gemessen im Live-Test v0.3 (2026-11-16, Debug-Log):
 * in ihnen entstanden die meisten Scheintreffer. Unbekannte Arten werden weiter geprüft.
 */
const SKIP_DEFAULT = 'deferred_tools_delta,skill_listing,agent_listing_delta,mcp_instructions_delta,model,date,remote_session_change'
/** Werte, die in jeder Claude-Code-Sitzung vorkommen und keine Personendaten sind. */
const ALLOW_DEFAULT = 'Claude,Claude Code,Claude Opus,Claude Sonnet,Claude Haiku,Claude Fable,Anthropic,Opus,Sonnet,Haiku,Fable'
/** Antworten, die eine Wiederholung lohnen: Drosselung und vorübergehende Störung. */
const RETRY = new Set([429, 502, 503, 504])
const PAUSES = [400, 1200, 3000]

const list = (v: unknown, fallback: string) =>
  new Set(String(v ?? fallback).split(',').map((t) => t.trim()).filter(Boolean))

// ── Erkennung ──────────────────────────────────────────────────────────────

/** Zeitgrenze je Anfrage: `$.http.fetch` hat keine. */
const TIMEOUT_MS = 8000
/** Höchstens so viele Anfragen gleichzeitig. */
const PARALLEL = 2
/** Die Pausen zwischen Wiederholungen bleiben in der Summe darunter: `$.clock.sleep` zählt zum Budget des Hooks. */
const PAUSE_BUDGET_MS = 4900

let active = 0
const waiting: Array<() => void> = []

/** Höchstens `PARALLEL` Anfragen zugleich; ein frei werdender Platz geht direkt an den nächsten Wartenden. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  else active++
  try {
    return await work()
  } finally {
    const nextUp = waiting.shift()
    if (nextUp) nextUp()
    else active--
  }
}

/** Eine Anfrage mit Zeitgrenze über `$.clock.after`; antwortet der Server nicht, wirft es nach 8 s. */
async function fetchOnce($: EngineInterface, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string; headers: Record<string, string> }> {
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(TIMEOUT_MS, () => reject(tagged(ownError(t('timeout', { s: TIMEOUT_MS / 1000 })), 'timeout')))
  })
  try {
    return await Promise.race([
      $.http.fetch(`${cfg.apiUrl}/api/mcp/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'X-Client-Version': CLIENT },
        body: JSON.stringify(body),
      }).catch((err: unknown) => {
        throw tagged(err, 'net')
      }),
      timeout,
    ])
  } finally {
    timer?.cancel()
  }
}

/** Die Wartezeit, die der Server nennt: `retry_after` im Körper oder die Kopfzeile `Retry-After`, in Sekunden. */
function retryAfterMs(res: { text: string; headers: Record<string, string> }): number | undefined {
  let fromBody: unknown
  try {
    fromBody = (JSON.parse(res.text) as { retry_after?: unknown }).retry_after
  } catch {
    fromBody = undefined
  }
  const raw = typeof fromBody === 'number' ? fromBody : Number(res.headers['retry-after'] ?? NaN)
  return Number.isFinite(raw) && raw >= 0 ? Math.max(100, raw * 1000) : undefined
}

/**
 * Eine Anfrage an die Erkennung, mit eigener Grenze, Zeitgrenze und Wiederholung bei
 * 429, 502, 503 und 504 nach `retry_after`/`Retry-After` oder festen Pausen, in Summe unter 5 s.
 * 401, 402 und 403 werden nicht wiederholt.
 */
async function post($: EngineInterface, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string; at: number }> {
  let paused = 0
  for (let attempt = 0; ; attempt++) {
    // Erst die Zeit holen, dann rechnen: `sent` darf nicht vor dem `await` gelesen werden, sonst
    // überschreibt bei zwei gleichzeitigen Anfragen die zweite den Eintrag der ersten.
    const now = await $.clock.now()
    const gate = rateWindow(sent, now, RATE_LIMIT, RATE_WINDOW)
    sent = gate.times
    if (gate.waitMs !== undefined) {
      throw ownError(t('rateLimit', { limit: RATE_LIMIT, wait: Math.ceil(gate.waitMs / 1000) }), 'rateLimit')
    }
    let res: Awaited<ReturnType<typeof fetchOnce>>
    try {
      res = await fetchOnce($, body)
    } catch (err) {
      ;(err as CheckError).checkAt ??= now
      throw err
    }
    if (!RETRY.has(res.status) || attempt >= PAUSES.length) return { ...res, at: now }
    const wait = retryAfterMs(res) ?? PAUSES[attempt] ?? 3000
    if (paused + wait > PAUSE_BUDGET_MS) return { ...res, at: now }
    paused += wait
    await $.clock.sleep(wait)
  }
}

async function analyze($: EngineInterface, text: string): Promise<Entity[]> {
  const hit = cfg.cache.get(text)
  if (hit) return hit
  if (!cfg.apiKey) throw ownError(t('noKey'), 'noKey')
  if (cfg.urlProblem) throw ownError(cfg.urlProblem, 'url')
  return slot(() => analyzeNow($, text))
}

/** Text des Vorwärmens: ohne Personendaten. */
const WARM_TEXT = 'anonym.legal: Vorwärmen der Erkennung.'

/**
 * Vorwärmen: je Sprache eine kurze Anfrage, an der Warteschlange vorbei. Das Ergebnis steht in
 * `GuardStats.warm` und in `/pii`; eine Sprache, die der Server nicht kennt, zeigt sich hier zuerst.
 * Im Kontomodus genau eine Anfrage ohne Sprache; sie zeigt, welche Sprachen der Server aus dem Konto nimmt.
 */
async function warm($: EngineInterface): Promise<void> {
  if (cfg.account) {
    let result: string
    const g = gen
    try {
      const r = await request($, { text: WARM_TEXT, output_mode: 'full' })
      let langs: string[]
      try {
        langs = accountLanguages(r)
      } catch (err) {
        throw languageFailed($, g, r, shownError(err), err instanceof Error ? OWN.get(err) : undefined)
      }
      checkPassed($, g, r)
      // Gespeichert wird ein fester Code, kein Text: `statsAtom` überlebt Neuladen und `--resume`.
      result = `ready:${shownLanguages(langs, cfg.lang).join(',')}`
    } catch (err) {
      result = storedCode(err)
    }
    await note($, (s) => ({ ...s, warm: { ...(s.warm ?? {}), account: result } }))
    return
  }
  const g = gen
  // Erst alle Sprachen, dann ein Ergebnis: „geschützt“ nur, wenn jede Sprache geprüft wurde.
  const answers: Array<{ r: Answer; ok: boolean; language: string }> = []
  await Promise.all(
    cfg.languages.map(async (language) => {
      let result: string
      try {
        const r = await request($, { text: WARM_TEXT, language, output_mode: 'full' })
        const ok = r.language === language
        answers.push({ r, ok, language })
        result = ok ? 'ready' : 'lang'
      } catch (err) {
        result = storedCode(err)
      }
      await note($, (s) => ({ ...s, warm: { ...(s.warm ?? {}), [language]: result } }))
    }),
  )
  const bad = answers.find((a) => !a.ok)
  if (bad) languageFailed($, g, bad.r, t('langUnsupported', { language: shownLanguage(bad.language, cfg.lang) }))
  else if (answers.length === cfg.languages.length && answers[0]) checkPassed($, g, answers[0].r)
}

/** Die Sprachen des Kontos, wie der Server sie zuletzt nannte; `undefined`: noch nicht bekannt. */
let accountUsed: string[] | undefined

/** Die Sprachen, die der Server im Kontomodus genommen hat; fehlen sie oder sind leer, wirft es (fail closed). */
function accountLanguages(r: Answer): string[] {
  if (!r.languagesUsed) throw ownError(t('accountUnsupported'), 'accountUnsupported')
  if (!r.languagesUsed.length) throw ownError(t('accountEmpty'), 'accountEmpty')
  accountUsed = r.languagesUsed
  return r.languagesUsed
}

/** Ob der Server den Sprachplan kennt (`metadata.languages_used`), je Ladung; `undefined`: noch nicht gefragt. */
let serverPlan: boolean | undefined

type Answer = { entities: Entity[]; language?: string; languagesUsed?: string[]; status: number; at: number }

/** Das Feld `error` einer Fehlerantwort, sonst `undefined`. */
function errorCode(text: string): unknown {
  try {
    return (JSON.parse(text) as { error?: unknown }).error
  } catch {
    return undefined
  }
}

/** Warum eine Anfrage scheiterte, in einem Satz; 401, 402 und 403 nennen den Grund. */
function failure(status: number, text: string): string {
  let data: { error?: string; unsupported?: unknown; language?: string } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    // kein JSON
  }
  if (status === 401) return t('http401')
  if (status === 402) return t('http402')
  if (status === 403) return t('http403')
  if (status === 400 && data.error === 'UNSUPPORTED_LANGUAGE') {
    // Gezeigt werden nur Codes der festen Liste, auch aus der eigenen Option; alles andere ist „andere“.
    const raw = Array.isArray(data.unsupported) ? data.unsupported.map(String) : cfg.languages
    const list = shownLanguages(raw, cfg.lang).join(', ')
    return t('http400lang', { list })
  }
  if (status === 503 && data.error === 'LANGUAGE_CATALOG_UNAVAILABLE') return t('http503catalog')
  if (status === 503 && data.error === 'MODEL_LOADING') return t('http503loading', { what: knownLanguage(data.language) ? ` ${knownLanguage(data.language)}` : '' })
  if (status === 429) return t('http429')
  return t('httpOther', { status })
}

/**
 * Hält den Ausgang einer Anfrage an die Erkennung fest (0.8), nur wenn sie in dieser Ladung begann, und
 * frischt die Statuszeile auf, ohne darauf zu warten.
 */
function recordCheck($: EngineInterface, g: number, check: Omit<LastCheck, 'gen'>): void {
  if (g !== gen) return
  const before = currentStatus()
  lastCheck = { ...check, gen: g }
  const after = currentStatus()
  // Nur bei einem Wechsel von Zustand oder Grund: die Zähler frischt `note` auf, und 540 Anfragen
  // sollen keine 540 Statuszeilen schreiben.
  if (before.state !== after.state || before.reason !== after.reason) void refreshUi($)
}

/** Die ganze Erkennung (alle Sprachen) ist durch: erst jetzt zählt die Prüfung als Erfolg. */
function checkPassed($: EngineInterface, g: number, a: Answer): void {
  recordCheck($, g, { ok: true, status: a.status, at: a.at })
}

/** Die Antwort kam, aber eine verlangte Sprache wurde nicht geprüft: failing mit Grund `language`. */
function languageFailed($: EngineInterface, g: number, a: { status: number; at: number }, message: string, code = 'other'): CheckError {
  recordCheck($, g, { ok: false, status: a.status, at: a.at, language: true })
  const e = tagged(ownError(message, code), a.status)
  e.checkReason = 'language'
  return e
}

/**
 * Eine Anfrage an die Erkennung. Scheitern wird hier festgehalten; ein Erfolg erst vom Aufrufer, wenn
 * auch die Sprachen stimmen (`checkPassed`), sonst `languageFailed`.
 */
async function request($: EngineInterface, body: Record<string, unknown>): Promise<Answer> {
  const g = gen
  let res: { ok: boolean; status: number; text: string; at: number }
  try {
    res = await post($, body)
  } catch (err) {
    // Netz und Zeitgrenze zählen als gescheiterte Prüfung; die eigene Grenze des Mods nicht.
    const e = err as CheckError
    if (e?.checkStatus !== undefined) recordCheck($, g, { ok: false, status: e.checkStatus, at: e.checkAt ?? 0 })
    throw err
  }
  const fail = (message: string): never => {
    recordCheck($, g, { ok: false, status: res.status, at: res.at })
    throw tagged(ownError(message), res.status)
  }
  // 400 UNSUPPORTED_LANGUAGE: der Server kennt die Sprache nicht, Grund `language`
  if (res.status === 400 && errorCode(res.text) === 'UNSUPPORTED_LANGUAGE') throw languageFailed($, g, res, failure(res.status, res.text))
  if (!res.ok) fail(failure(res.status, res.text))
  let data: { success?: boolean; entities?: Entity[]; metadata?: { language?: unknown; languages_used?: unknown } } = {}
  try {
    data = JSON.parse(res.text) as typeof data
  } catch {
    fail(t('unreadable'))
  }
  // Streng lesen: Eine Antwort, die anders aussieht als vereinbart, ist kein „nichts gefunden“.
  // Sonst ginge die Zeile bei `success: true` ohne `entities` ungeschwärzt durch.
  if (data.success !== true) fail(t('noSuccess'))
  if (!Array.isArray(data.entities)) return fail(t('noEntities'))
  for (const e of data.entities) {
    if (!e || typeof e !== 'object' || typeof e.start !== 'number' || typeof e.end !== 'number' || typeof e.entity_type !== 'string') {
      fail(t('badEntity'))
    }
  }
  const used = data.metadata?.languages_used
  return {
    status: res.status,
    at: res.at,
    entities: data.entities,
    language: typeof data.metadata?.language === 'string' ? data.metadata.language.toLowerCase() : undefined,
    languagesUsed: Array.isArray(used) ? used.map((l) => String(l).toLowerCase()) : undefined,
  }
}

/**
 * Kontomodus: eine Anfrage je Stück ohne `language` und `languages`; der Server nimmt die Sprachen des
 * Kontos und nennt sie in `metadata.languages_used` (fehlt das oder ist es leer, wirft es). Sonst:
 * Eine Anfrage je Text mit allen Sprachen. Der neue Server prüft sie über den Sprachplan und
 * nennt sie in `metadata.languages_used`; jede Sprache, die dort fehlt, wird einzeln nachgeholt. Nennt
 * die Antwort nur `metadata.language`, gilt nur die erste Sprache als geprüft. Bei einer Einzelanfrage
 * muss `metadata.language` die verlangte Sprache sein. Scheitert etwas, wirft es.
 */
async function analyzeNow($: EngineInterface, text: string): Promise<Entity[]> {
  const hit = cfg.cache.get(text)
  if (hit) return hit
  const langs = cfg.languages
  const first = langs[0]
  if (first === undefined && !cfg.account) throw ownError(t('noValidLang'), 'noValidLang')
  const g = gen
  const unsupported = (a: Answer, language: string) => languageFailed($, g, a, t('langUnsupported', { language: shownLanguage(language, cfg.lang) }))
  let last: Answer | undefined
  const all: Entity[] = []
  const collect = (entities: readonly Entity[], start: number) => {
    for (const e of entities) {
      if (typeof e.start === 'number' && typeof e.end === 'number') all.push({ ...e, start: e.start + start, end: e.end + start })
    }
  }
  for (const { piece, start } of chunks(text, CHUNK, OVERLAP)) {
    const extra: Record<string, unknown> = cfg.preset ? { preset: cfg.preset } : {}
    if (first === undefined) {
      const answer = await request($, { text: piece, output_mode: 'full', ...extra })
      try {
        accountLanguages(answer)
      } catch (err) {
        throw languageFailed($, g, answer, shownError(err), err instanceof Error ? OWN.get(err) : undefined)
      }
      last = answer
      collect(answer.entities, start)
      continue
    }
    const plan = await request($, { text: piece, language: first, languages: langs, output_mode: 'full', ...extra })
    last = plan
    collect(plan.entities, start)
    let done: Set<string>
    if (plan.languagesUsed) {
      serverPlan = true
      done = new Set(plan.languagesUsed)
    } else {
      serverPlan = false
      if (plan.language !== first) throw unsupported(plan, first)
      done = new Set([first])
    }
    for (const language of langs) {
      if (done.has(language)) continue
      const one = await request($, { text: piece, language, output_mode: 'full', ...extra })
      if (one.language !== language) throw unsupported(one, language)
      last = one
      collect(one.entities, start)
    }
  }
  if (last) checkPassed($, g, last)
  const found = dedupe(all)
  if (cfg.cache.size >= CACHE_MAX) cfg.cache.delete(cfg.cache.keys().next().value as string)
  cfg.cache.set(text, found)
  return found
}

/** Der Vault dieser Sitzung, beim ersten Zugriff mit zufälligem Tag. */
async function vaultOf($: EngineInterface): Promise<Vault> {
  const v = await read($, vaultAtom)
  if (v.tag) return v
  let out = v
  await update($, vaultAtom, (old) => (out = old.tag ? old : { ...old, tag: newTag((n) => crypto.getRandomValues(new Uint8Array(n))) }))
  return out
}

const keep = (e: Entity) => plausible(e, cfg.minScore, cfg.ignoreTypes, cfg.allowValues)

/**
 * Kodierte Abschnitte: mit bekanntem Wert lokal ersetzen, die übrigen dekodierbaren in
 * einer Anfrage prüfen und nur die mit Treffer ersetzen. Scheitert die Anfrage, wirft es, und die
 * Zeile wird zurückgehalten.
 */
async function scrubEncoded($: EngineInterface, text: string, vault: Vault, dry: boolean): Promise<string> {
  const plan = encodedPlan(text, vault, cfg.encodedRuns)
  const spans = [...plan.replace]
  if (plan.ask.length) {
    const decoded = plan.ask.map((r) => r.decoded)
    const found = (await analyze($, decoded.join(RUN_SEPARATOR))).filter(keep)
    for (const i of runsWithHits(decoded, found)) {
      const r = plan.ask[i]
      if (r) spans.push(r)
    }
  }
  if (!spans.length) return text
  if (!dry) await note($, (s) => ({ ...s, encoded: (s.encoded ?? 0) + spans.length }))
  return replaceSpans(text, spans, t('encodedWithheld'))
}

/**
 * Schwärzt einen Text: kodierte Abschnitte, bekannte Werte, dann die Treffer der Erkennung.
 * `dry` (für den Prompt vorab) schickt dieselben Anfragen, ändert aber den Vault nicht; so trifft
 * die spätere Zeile den Zwischenspeicher.
 */
async function scrub($: EngineInterface, text: string, dry = false): Promise<string> {
  // Der eigene Hinweis fürs Modell wird nicht geschwärzt (Live-Test v0.4: mit englischer Erkennung
  // wurden Wörter darin ersetzt, und der Hinweis kam verstümmelt an).
  const own = hints().find((h) => text.includes(h))
  if (own) {
    const parts = text.split(own)
    const out: string[] = []
    for (const p of parts) out.push(await scrub($, p, dry))
    return out.join(own)
  }
  if (!worthScanning(text)) return text
  const before = await vaultOf($)
  const plain = cfg.encodedRuns === 'off' ? text : await scrubEncoded($, text, before, dry)
  const swept = sweepKnown(plain, before).text
  // Ein Namens-Treffer, der selbst ein kodierter Abschnitt ist, ist ein Zufallstreffer; den
  // Abschnitt hat scrubEncoded schon geprüft (live gemessen 2026-11-16).
  const entities = (await analyze($, swept)).filter((x) => keep(x) && !insideAllowed(swept, x, cfg.allowValues) && !insideWord(swept, x) && (cfg.encodedRuns === 'off' || !encodedNameHit(x)))
  if (dry) return swept
  let result = swept
  await update($, vaultAtom, (v) => {
    // Neu auf dem aktuellen Vault: Schreibvarianten legen Platzhalter an, und eine
    // andere Zeile kann den Vault inzwischen erweitert haben. Passen die Offsets dann nicht mehr,
    // ersetzt applyEntities über den gemeldeten Text.
    const s1 = sweepKnown(plain, v)
    const applied = applyEntities(s1.text, entities, s1.vault)
    const again = sweepKnown(applied.text, applied.vault)
    result = again.text
    return { ...again.vault, replaced: v.replaced + s1.count + applied.count + again.count }
  })
  return result
}

async function scrubBlocks($: EngineInterface, content: readonly Block[]): Promise<Block[]> {
  const out: Block[] = []
  let droppedTop = false
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ ...block, text: await scrub($, block.text) })
    } else if (block.type === 'tool_result') {
      const inner = block.content
      if (typeof inner === 'string') {
        out.push({ ...block, content: await scrub($, inner) })
      } else if (Array.isArray(inner)) {
        const kept: Block[] = []
        let marker = ''
        for (const b of inner as Block[]) {
          if (typeof b.text === 'string') kept.push({ ...b, text: await scrub($, b.text) })
          else if (b.type === 'image' || b.type === 'document') {
            if (cfg.media === 'drop') marker = t('mediaDropped')
            else kept.push(b)
          } else marker ||= t('unknownDropped')
        }
        if (marker && !kept.some((b) => b.type === 'text')) kept.push({ type: 'text', text: marker })
        out.push({ ...block, content: kept })
      } else {
        out.push(block)
      }
    } else if (block.type === 'image' || block.type === 'document') {
      if (cfg.media === 'drop') droppedTop = true
      else out.push(block)
    } else {
      // tool_use, thinking und Unbekanntes setzt die Engine ohnehin wieder ein.
      out.push(block)
    }
  }
  if (droppedTop && !out.some((b) => b.type === 'text' || b.type === 'tool_result')) out.push({ type: 'text', text: t('mediaDropped') })
  return out
}

/** Was statt einer Zeile gespeichert wird, deren Prüfung scheiterte: Text weg, Paarung bleibt. */
function withheld(content: readonly Block[]): Block[] {
  return content
    .map((b) => {
      if (b.type === 'text') return { ...b, text: t('withheld') }
      if (b.type === 'tool_result') return { ...b, content: t('withheld') }
      return b
    })
    .filter((b) => b.type !== 'image' && b.type !== 'document')
}

async function note($: EngineInterface, patch: (s: GuardStats) => GuardStats): Promise<void> {
  // Die Statistik ist Anzeige: keine Schutzentscheidung liest sie. Ein Fehler beim Fortschreiben (kaputter
  // Bestand, Speicher) darf deshalb weder eine Sperre aufheben noch eine Zeile zurückhalten (0.9).
  await safeUi(() => update($, statsAtom, (old) => patch(old)))
  // Nicht abwarten: ein Fehler der Statuszeile darf den Schutzpfad nicht berühren (0.8).
  void refreshUi($)
}

/** Wann zuletzt ein Toast je Art gezeigt wurde (Modulvariable: nach einem Neuladen höchstens ein Toast mehr). */
const toastTimes: Partial<Record<RefuseKind, number[]>> = {}

/**
 * Der Text einer Absage des Mods (0.9): hängt den nächsten Schritt an, zählt die Absage, wo die Stelle es nicht
 * selbst tut, und meldet sie als Toast. Der Toast hat einen festen Text je Art, nie den Absagetext (der kann
 * Platzhalter tragen) und geht laut Typdatei auch an entfernte Geräte. Gewartet wird auf nichts: Zählen und
 * Toast laufen neben der Rückgabe, ihre Fehler erreichen den Schutzpfad nicht.
 */
function refused($: EngineInterface, kind: RefuseKind, text: string, counted = false): string {
  if (!counted) void note($, (s) => ({ ...s, blocked: s.blocked + 1 }))
  if (kind !== 'count' && TOAST_KINDS.has(kind)) {
    void safeUi(async () => {
      const gate = rateWindow(toastTimes[kind] ?? [], await $.clock.now(), 1, TOAST_WINDOW_MS)
      toastTimes[kind] = gate.times
      if (gate.waitMs === undefined) $.ui.toast(t(`toast_${kind}`))
    })
  }
  return `${text} ${t('refusedNext')}`
}

/** Der Zustand dieser Ladung, aus der einen Quelle `deriveStatus`. */
const currentStatus = (): DerivedStatus => deriveStatus({ hasKey: !!cfg.apiKey, urlProblem: !!cfg.urlProblem, lastCheck, gen })

/** Was als nächstes zu tun ist, zu einem Grund; ohne Grund der Verweis auf /pii. */
const nextStep = (reason: DerivedStatus['reason']) => t(reason ? (`next_${reason}` as const) : 'next_other')

/**
 * Setzt die Statuszeile aus `deriveStatus` (0.8). Wirft nie: alles steht in try/catch, und die
 * Schutz-Hooks warten nicht darauf. Kein Klarwert, kein Token: nur Zustand, Grund und Zähler.
 */
async function refreshUi($: EngineInterface): Promise<void> {
  await safeUi(async () => {
    const st = currentStatus()
    let text: string
    if (st.state === 'protected') {
      const v = await read($, vaultAtom)
      const s = await read($, statsAtom)
      text = t('statusProtected', { n: v.replaced, m: s.blocked })
    } else if (st.state === 'checking') text = t('statusChecking')
    else if (st.state === 'unset') text = t('statusUnset')
    else text = t('statusFailing', { reason: t(`reason_${st.reason ?? 'server'}` as const) })
    // Wo die Anzeige Platzhalter zeigt, sagt es die Statuszeile.
    const remote = await placeholderSurfaces($)
    if (remote.length) text += ` · ${t('placeholdersOn', { surface: remote.join(', ') })}`
    await $.ui.status(text)
  })
  scheduleRefresh($)
}

// ── Seitenleiste und Band: gedrosselt neu zeichnen ─────────────────

/** Höchstens ein eigenes `invalidate` je Sekunde. */
const REFRESH_MS = 1000
/** Ein Neuzeichnen ist bestellt (sofort unterwegs oder über `$.clock.after`); weitere schließen sich an. */
let refreshPending = false
let lastInvalidate = Number.NEGATIVE_INFINITY
/** Was das Band zuletzt zeigen sollte; ein Wechsel muss gezeichnet werden, auch ohne offene Pane. */
let drawnBand = ''
let bandDirty = false

/** Ob die eigene Pane offen und gezeichnet ist (`$.ui.panes()`). */
async function paneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((p) => p.id === PANE_ID && p.isPlaced)
}

/**
 * Fasst Aktualisierungen zusammen: `invalidate('ui.render')` nur bei offener Pane oder wenn das Band
 * wechselt, und höchstens einmal je `REFRESH_MS`. Wirft nie und wird nie abgewartet (Schutzpfad).
 */
function scheduleRefresh($: EngineInterface): void {
  const key = bandKey(currentStatus())
  if (key !== drawnBand) {
    drawnBand = key
    bandDirty = true
  }
  if (refreshPending) return
  refreshPending = true
  const g = gen
  let handedOff = false
  void safeUi(async () => {
    try {
      const open = await paneOpen($).catch(() => false)
      if (!open && !bandDirty) return
      const now = await $.clock.now()
      const wait = lastInvalidate + REFRESH_MS - now
      if (wait <= 0) {
        lastInvalidate = now
        bandDirty = false
        $.ui.invalidate('ui.render')
        return
      }
      $.clock.after(wait, () => {
        void safeUi(async () => {
          try {
            if (g !== gen) return
            // Erneut prüfen: die Pane kann inzwischen zu sein, der Zeitgeber spät feuern.
            const stillOpen = await paneOpen($).catch(() => false)
            if (!stillOpen && !bandDirty) return
            lastInvalidate = await $.clock.now()
            bandDirty = false
            $.ui.invalidate('ui.render')
          } finally {
            if (g === gen) refreshPending = false
          }
        })
      })
      handedOff = true
    } finally {
      if (!handedOff) refreshPending = false
    }
  })
}

/** Die eigenen Befehle und die Texte, die sie zuletzt zurückgegeben haben (0.9, siehe `ownCommandText`). */
const OWN_COMMANDS = ['pii', 'pii-settings', 'pii-setup'] as const
const ownOutputs = new Set<string>()
/** Merkt sich den Text eines eigenen Befehls, damit seine Zeile ungeprüft durchgeht. Höchstens die letzten acht. */
function ownText(text: string): { text: string } {
  ownOutputs.add(text.trim())
  while (ownOutputs.size > 8) ownOutputs.delete(ownOutputs.values().next().value as string)
  return { text }
}
/** Ob eine Zeile der Tür `command` ganz aus den genauen Formen eines eigenen Befehls besteht. */
function ownCommandRow(content: unknown): boolean {
  const blocks = Array.isArray(content) ? content : [content]
  const own = { plugin: 'anonym-legal-guard', commands: OWN_COMMANDS, outputs: ownOutputs }
  return (
    blocks.length > 0 &&
    blocks.every((b) =>
      typeof b === 'string' ? ownCommandText(b, own) : !!b && (b as { type?: unknown }).type === 'text' && ownCommandText(String((b as { text?: unknown }).text ?? ''), own),
    )
  )
}

/**
 * Unter welchem Namen Claude Code diesen Mod führt (`anonym-legal-guard@anonym-legal`, mit `--plugin-dir`
 * `anonym-legal-guard@inline`): der Besitzer einer eigenen `/config`-Zeile. Ohne solche Zeile (kopflos) der
 * Name aus dem Marktplatz.
 */
async function ownPluginId($: EngineInterface): Promise<string> {
  try {
    const row = (await $.config.list()).find((r) => r.key.startsWith('anonym-legal-guard.'))
    const id = String((row?.provider as { plugin?: unknown } | undefined)?.plugin ?? '')
    if (/^anonym-legal-guard(@[a-z0-9._-]+)?$/.test(id)) return id
  } catch {
    // keine Liste: Rückfall
  }
  return 'anonym-legal-guard@anonym-legal'
}

function worthRow(door: string, name: string | undefined, origin: string | undefined): boolean {
  return rowIsScanned(door, name, origin, cfg)
}

function originKind(origin: unknown): string | undefined {
  return origin && typeof origin === 'object' && 'kind' in origin ? String((origin as { kind: unknown }).kind) : undefined
}

/** Die Argumente eines lokalen Werkzeugs mit den echten Werten; reservierte Felder bleiben. */
async function restoreArgs<T extends object>($: EngineInterface, e: T): Promise<T | { leftover: string[] }> {
  const v = await vaultOf($)
  const args: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(e)) args[k] = RESERVED.has(k) ? val : detokenizeDeep(val, v)
  const leftover = leftoverTokens(Object.fromEntries(Object.entries(args).filter(([k]) => !RESERVED.has(k))))
  return leftover.length ? { leftover } : (args as T)
}

const LEFTOVER = (list: string[]) => `${t('leftover', { list: [...new Set(list)].slice(0, 3).join(', ') })} ${t('notALock')}`

/** Der Befehlstext eines Shell-Werkzeugs; ein Monitor auf eine WebSocket hat keinen. Unlesbar: wirft. */
function commandOf(tool: string, input: unknown): string | undefined {
  const c = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof c === 'string') return c
  if (tool === 'Monitor' && c === undefined) return undefined
  throw ownError(t('commandUnreadable'))
}

const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit'])
const STRICT_FILES = () => `${t('strictFiles')} ${t('notALock')}`
const EGRESS_STOPPED = () => t('egressStopped')
const RESTORE_FAILED = () => `${t('restoreFailed')} ${t('notALock')}`
const TOKEN_COUNT_WITHHELD = () => `${t('tokenCountWithheld')} ${t('notALock')}`
const LEAK_STOPPED = () => `${t('leakStopped')} ${t('notALock')}`

/** Die Fassung von Claude Code und die Oberflächen für /pii; was die Engine nicht nennt, heißt „unbekannt“. */
async function environment($: EngineInterface): Promise<{ cc: string; surfaces: string; list?: readonly string[] }> {
  let cc = t('unknown')
  let surfaces = t('unknown')
  let found: readonly string[] | undefined
  try {
    cc = String((await $.session.version()).version ?? cc)
  } catch {
    // ältere Fassung oder Testumgebung
  }
  try {
    const list = await $.session.surfaces()
    surfaces = list.length ? [...new Set(list.map((s) => shownSurface(String(s), cfg.lang)))].join(', ') : '–'
    found = list
  } catch {
    // ältere Fassung oder Testumgebung
  }
  return { cc, surfaces, list: found }
}

/**
 * Die Hinweise für `mayRevealOnSurface`. Claude Code 2.1.326 nennt keine verlässliche Lokal-Quelle
 * `surfaces()` und `session.attach` tragen nur den erklärten Namen, `isHosted` betrifft die
 * Maschine der Engine (und `$.session.info` fehlt in 2.1.325 der Desktop-App). Darum kein `local`: `vscode` zeigt
 * Platzhalter. Für `desktop` zählen die aktuelle Liste aus `surfaces()` (je Anzeige neu gelesen, kein Cache)
 * und die Clients aus `clientsAtom` (fortgeschrieben von `session.attach`/`detach`): `surfaces()` nennt jede
 * Oberfläche nur einmal, zwei Clients auf `desktop` sind dort nicht zu unterscheiden. Liste oder Zähler nicht
 * lesbar: das Signal fehlt, also Platzhalter auf `desktop`.
 * Restlücke: nur, wenn der Mod erst geladen wird, nachdem sich schon ein Fernzugriff angemeldet hat (dessen
 * `session.attach` hat der Mod nie gesehen).
 */
async function surfaceSignals($: EngineInterface, list?: readonly string[]): Promise<SurfaceSignals> {
  let clients: number | undefined
  try {
    // Kein Feld aus Zeichenketten: nicht lesbar (Platzhalter). Fehlt der Wert ganz (neue Sitzung, andere `shape`),
    // gilt die leere Liste.
    const c: unknown = await read($, clientsAtom)
    clients = Array.isArray(c) && c.every((x) => typeof x === 'string') ? c.length : undefined
  } catch {
    clients = undefined
  }
  if (list) return { surfaces: list.map(String), clients }
  try {
    return { surfaces: (await $.session.surfaces()).map(String), clients }
  } catch {
    return { clients }
  }
}

/** Die angehängten Oberflächen, auf denen nicht rückübersetzt wird; unlesbar: keine (nur Anzeige). */
async function placeholderSurfaces($: EngineInterface): Promise<string[]> {
  try {
    const list = (await $.session.surfaces()).map(String)
    const sig = await surfaceSignals($, list)
    return [...new Set(list.filter((s) => !mayRevealOnSurface(String(s), sig)).map((s) => shownSurface(String(s), cfg.lang)))]
  } catch {
    return []
  }
}

/** Die Bauteile, deren Text oder Argumente der Mensch sieht (Typdatei 2.1.326, `RenderPropsOf`). */
// Werkzeugeigene Darstellungen (TodoWrite, Task/Agent, Bash-Beschreibung, WebFetch-URL) laufen über ToolUse,
// ToolResult und ToolGroup (Feld `tool`); eigene Bauteile mit Inhalt sind AskUserQuestion (`questions`),
// Spinner (`message`), AgentRow (Beschreibung des Agenten) und AbovePromptList (`rows`, z. B. Aufgabenliste).
// Nicht aufgenommen: ContextMenu (zeigt nur, was die Person auf DIESER Oberfläche markiert hat), Pane/Placed/
// Backdrop/AbovePrompt (Inhalt von Mods), TurnDuration/SessionMode/PromptHint (kein Inhalt der Unterhaltung).
// `AgentRow` fehlt bewusst: Claude Code 2.1.325 (in der Desktop-App gebündelt) kennt das Bauteil nicht, und ein
// unbekanntes Bauteil im Matcher lässt die Registrierung scheitern; dann fehlten alle Schutz-Hooks.
// tests/compat.test.ts prüft jedes Bauteil und jedes Ereignis gegen die Liste von 2.1.325.
export const SHOWN = [
  'AssistantMessage', 'UserMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'ToolProgress', 'InfoNotice',
  'AskUserQuestion', 'Spinner', 'AbovePromptList',
] as const
const MESSAGES = new Set<string>(['AssistantMessage', 'UserMessage'])

/** Was eine entfernte Oberfläche statt eines Bauteils zeichnet, wenn das Bereinigen scheiterte: kein Inhalt. */
const withheldRender = () => ({ type: 'Text', props: {}, children: [t('renderWithheld')] }) as never

/**
 * Das Ereignis, wie es auf dieser Oberfläche gezeichnet wird: lokal Nachrichten mit echten Werten (Werkzeugzeilen
 * wie bisher), entfernt alle Texte mit Platzhaltern. Kann werfen; der Aufrufer ruft `next` erst danach.
 */
async function shownOn<E extends { component: string; props: unknown }>($: EngineInterface, e: E, reveal: boolean): Promise<E> {
  const v = await read($, vaultAtom)
  if (reveal) {
    if (!MESSAGES.has(e.component)) return e
    const text = (e.props as { text: string }).text
    const plain = detokenize(text, v)
    return plain === text ? e : ({ ...e, props: { ...(e.props as object), text: plain } } as E)
  }
  const props = sweepKnownDeep(e.props, v)
  return props === e.props ? e : ({ ...e, props } as E)
}

/** Die Erkennungssprachen für /pii und die Pane: Konto (mit den Sprachen, sobald bekannt) oder die Codes aus der Option. */
function languageLine(): string {
  if (cfg.account) return accountUsed ? t('langAccountKnown', { langs: shownLanguages(accountUsed, cfg.lang).join(', ') }) : t('langAccount')
  return t('langExplicit', { langs: cfg.languages.length ? shownLanguages(cfg.languages, cfg.lang).join('+') : t('langNone') })
}

/** Die Eingabe der Pane aus `deriveStatus`, `statsAtom`, `vaultAtom.counter` und dem Fenster `sent`. */
async function paneInput($: EngineInterface): Promise<PaneInput> {
  const v = await read($, vaultAtom)
  const s = await read($, statsAtom)
  const now = await $.clock.now()
  let surfaces: PaneInput['surfaces'] = []
  try {
    const list = (await $.session.surfaces()).map(String)
    const sig = await surfaceSignals($, list)
    surfaces = list.map((x) => ({ name: x, placeholders: !mayRevealOnSurface(x, sig) }))
  } catch {
    // ältere Fassung oder Testumgebung
  }
  const check = lastCheck && lastCheck.gen === gen ? { status: lastCheck.status, at: lastCheck.at } : undefined
  return {
    lang: cfg.lang,
    status: currentStatus(),
    check,
    languages: languageLine(),
    replaced: v.replaced,
    counter: v.counter,
    blocked: s.blocked,
    leaks: s.leaks,
    withheld: s.withheld,
    inWindow: rateWindow(sent, now, Number.MAX_SAFE_INTEGER, RATE_WINDOW).times.length - 1,
    limit: RATE_LIMIT,
    surfaces,
  }
}

/** Taste r / Klick in der Pane: dieselbe Prüfung wie /pii, danach neu zeichnen. */
async function recheck($: EngineInterface): Promise<void> {
  if (cfg.apiKey && !cfg.urlProblem) await warm($).catch(() => undefined)
  void refreshUi($)
}

export const register: Register = (on, options) => {
  const rawOptions = options as Record<string, unknown>
  const languageOption = String(options.language ?? 'account')
  cfg = {
    apiUrl: String(options.api_url ?? 'https://anonym.legal').replace(/\/+$/, ''),
    apiKey: String(options.api_key ?? ''),
    lang: parseLang(options.ui_language),
    account: isAccountOption(languageOption),
    languages: isAccountOption(languageOption) ? [] : parseLanguages(languageOption),
    preset: String(options.preset ?? ''),
    leakGuard: String(options.leak_guard ?? 'block'),
    encodedRuns: String(options.encoded_runs ?? 'scan'),
    shellGuard: String(options.shell_guard ?? 'block'),
    fileValues: String(options.file_values ?? 'real'),
    media: String(options.media ?? 'drop'),
    detokenizeBash: options.detokenize_bash === true,
    minScore: Number(options.min_score ?? 0.5),
    ignoreTypes: new Set([...list(options.ignore_types, 'URL,DATE_TIME,NRP,ORGANIZATION')].map((t) => t.toUpperCase())),
    scanHookContext: options.scan_hook_context !== false,
    skipAttachments: list(options.skip_attachments, SKIP_DEFAULT),
    allowValues: new Set([...list(options.allow_values, ALLOW_DEFAULT)].map((v) => v.toLowerCase())),
    cache: new Map(),
  }
  cfg.urlProblem = apiUrlProblem(cfg.apiUrl, options.allow_other_host === true, cfg.lang)
  // Erlaubte Werte („Claude“) werden auch kein Namensteil mit eigenem Platzhalter.
  setAliasDeny(cfg.allowValues)
  // Der Zähler der eigenen Grenze bleibt über ein Neuladen bestehen: sonst höbe jedes Neuladen sie auf.
  serverPlan = undefined
  accountUsed = undefined
  active = 0
  waiting.length = 0
  // Neue Ladung: ohne erfolgreiche Prüfung in dieser Ladung gibt es kein „geschützt“ (0.8).
  gen++
  lastCheck = undefined
  refreshPending = false
  lastInvalidate = Number.NEGATIVE_INFINITY
  drawnBand = ''
  bandDirty = false
  const { apiUrl, apiKey, preset, leakGuard, detokenizeBash, shellGuard } = cfg

  /** Je angehängter Oberfläche, ob dort rückübersetzt wird; dazu der Hinweis für die mit Platzhaltern. */
  const surfaceLines = (list: readonly string[] | undefined, sig: SurfaceSignals): string[] => {
    if (!list?.length) return []
    const each = list.map((s) => t(mayRevealOnSurface(String(s), sig) ? 'surfaceReal' : 'surfacePlaceholder', { surface: shownSurface(String(s), cfg.lang) }))
    const remote = [...new Set(list.filter((s) => !mayRevealOnSurface(String(s), sig)).map((s) => shownSurface(String(s), cfg.lang)))]
    return [t('piiSurfaces', { list: each.join(' · ') }), ...(remote.length ? [t('placeholdersOn', { surface: remote.join(', ') })] : [])]
  }

  // ── Sitzung und Befehl ───────────────────────────────────────────────────

  // Kommt oder geht eine Oberfläche, stimmt der Hinweis der Statuszeile wieder.
  // Die Clients zählen für `desktop` (siehe `surfaceSignals`).
  on('session.attach', async ($, e, next) => {
    const id = String(e.clientId)
    await update($, clientsAtom, (c) => (c.includes(id) ? c : [...c, id]))
    const r = await next(e)
    void refreshUi($)
    return r
  })
  on('session.detach', async ($, e, next) => {
    const id = String(e.clientId)
    await update($, clientsAtom, (c) => (c.includes(id) ? c.filter((x) => x !== id) : c))
    const r = await next(e)
    void refreshUi($)
    return r
  })

  // ── 0b. Die Optionen des Mods ändert nur die Hand am Rechner (0.9) ──
  // Ein angehängtes Gerät (Remote Control) oder ein fremder Mod könnte sonst `leak_guard`, `shell_guard` oder
  // `file_values` über `/config` bzw. `$.config.set` abschwächen. `.catch` lehnt für eigene Zeilen ab (laut
  // Typdatei wird ein gescheiterter Wächter sonst übersprungen und die Zeile geschrieben); fremde Zeilen reicht
  // er weiter.
  on('config.set', async ($, e, next) => {
    if (ownOptionChange(e.key, e.origin) !== 'deny') return next(e)
    void safeUi(() => $.ui.log(t('logConfigDenied', { field: e.key.slice(e.key.indexOf('.') + 1), origin: originKind(e.origin) ?? '?' })))
    return { deny: t('configDenied') }
  }).catch(($, e, next) => (next.called || ownOptionChange(e.key, e.origin) === 'foreign' ? next(e) : { deny: t('configDenied') }))

  on('session.start', async ($, e, next) => {
    // Ein Befehl, der sich nicht registrieren lässt, darf Statuszeile und Vorwärmen nicht aufhalten (0.9).
    await safeUi(() => $.command.register({ name: 'pii', description: t('cmdDescription') }))
    await safeUi(() => $.command.register({ name: 'pii-settings', description: cfg.lang === 'de' ? 'anonym.legal: alle Einstellungen mit Standard und Profilen' : 'anonym.legal: all settings with defaults and profiles' }))
    await safeUi(() => $.command.register({ name: 'pii-setup', description: cfg.lang === 'de' ? 'anonym.legal: Einrichtung Schritt für Schritt' : 'anonym.legal: setup step by step' }))
    void refreshUi($)
    // Vorwärmen ohne zu warten: über einen Zeitgeber, damit die Arbeit den Start überdauert
    // (Referenz „Work that outlives a dispatch“). `session.start` läuft bei jeder frischen Ladung
    // (Typdatei: „once per fresh load“), also prüft jede Ladung selbst; `register` hat kein `$`.
    if (apiKey && !cfg.urlProblem) $.clock.after(0, () => void warm($).catch(() => undefined))
    return next(e)
  })

  // Nicht `ownText`: der Bericht zeigt die Optionswerte unverändert (ein Preset kann einen Namen tragen), seine Zeile
  // geht deshalb durch die Erkennung wie fremder Text (Codex-Prüfung 0.9).
  on('command.run', { command: 'pii-settings' }, async () => ({ text: settingsReport(rawOptions, cfg.lang, VERSION) }))

  // /pii-setup (0.9): führt durch die Einrichtung. Ohne Token nur der Weg zum Token: der Mod stößt den
  // Einstellungsdialog von Claude Code an (`/plugin configure <mod>`), denn nur der speichert ein Geheimnis; der Mod
  // kann ein sensitives Feld nicht setzen (gemessen: es ist keine `/config`-Zeile) und nimmt den Token nie selbst an.
  // Mit Token: Sprache und Profil; die Standardwahl braucht keinen Befehl. Abbruch, freie Eingabe und Sitzungen
  // ohne Dialog (`claude -p`) ergeben die Standardwahl; eine freie Eingabe wird nie ausgegeben.
  on('command.run', { command: 'pii-setup' }, async ($) => {
    // Mit Token erst prüfen, wie `/pii`: nach einem Neuladen steht der Zustand sonst auf „prüft“, und ein
    // ungültiger Token fiele nicht auf (Rückmeldung des Eigentümers 2026-11-20).
    if (apiKey && !cfg.urlProblem) await warm($).catch(() => undefined)
    const st = currentStatus()
    const needsToken = !apiKey || st.reason === 'unauthorized'
    // Im Token-Schritt sind die Schritte selbst der nächste Schritt: kein doppelter Verweis.
    const next = needsToken ? '' : nextStep(st.reason)
    const detail = st.reason ? t('piiStateDetail', { reason: t(`reason_${st.reason}` as const), next }).trimEnd() : ''
    const stateLine = t('piiState', { state: t(`state_${st.state}` as const), detail })
    if (needsToken) {
      const id = await ownPluginId($)
      // Über einen Zeitgeber: aus einem `command.run`-Hook heraus lehnt die Engine `$.command.run` ab („it would
      // wait on the turn this hook is holding“). So läuft `/plugin configure` gleich nach dieser Anleitung. Scheitert
      // es, steht der Befehl in der Anleitung; der Grund geht ins Debug-Log.
      $.clock.after(0, () =>
        void Promise.resolve()
          .then(() => $.command.run({ command: 'plugin', args: `configure ${id}` } as never))
          .catch((err: unknown) => safeUi(() => $.ui.log(`anonym.legal: settings dialog not opened (${err instanceof Error ? err.message.slice(0, 160) : 'error'})`, { to: 'debug' }))),
      )
      return ownText(setupTokenText({ lang: cfg.lang, stateLine, configure: `/plugin configure ${id}`, replace: !!apiKey }))
    }
    // Ein anderer Fehler (Guthaben, Tarif, Netz, Sprache, Adresse): erst den beheben, keine Fragen.
    if (st.state !== 'protected' && st.state !== 'checking') return ownText(setupStateText({ lang: cfg.lang, stateLine }))
    const answers: { language?: string; profile?: string } = {}
    const q = setupQuestions(cfg.lang)
    try {
      answers.language = await $.ui.ask(q.language.question, { options: q.language.options, header: q.language.header })
      answers.profile = await $.ui.ask(q.profile.question, { options: q.profile.options, header: q.profile.header })
    } catch {
      // kein Dialog oder abgebrochen: Standardwahl
    }
    return ownText(setupOptionsText({ lang: cfg.lang, stateLine, plan: setupPlan(answers, cfg.lang) }))
  })

  // /pii ist ein Selbsttest (0.8): erst eine neue Prüfung (mit der Zeitgrenze jeder Anfrage), dann die Auskunft.
  on('command.run', { command: 'pii' }, async ($) => {
    if (apiKey && !cfg.urlProblem) await warm($).catch(() => undefined)
    const v = await read($, vaultAtom)
    const s = await read($, statsAtom)
    const tainted = await read($, taintedAtom)
    const inWindow = rateWindow(sent, await $.clock.now(), Number.MAX_SAFE_INTEGER, RATE_WINDOW).times.length - 1
    const types = shownTypes(v.counter, cfg.lang)
    const st = currentStatus()
    const state = t(`state_${st.state}` as const)
    const detail = st.reason ? t('piiStateDetail', { reason: t(`reason_${st.reason}` as const), next: nextStep(st.reason) }) : ''
    const code = lastCheck && lastCheck.gen === gen ? String(lastCheck.status) : '–'
    const env = await environment($)
    const plan = serverPlan === undefined ? t('planUnknown') : serverPlan ? t('planYes') : t('planNo')
    void refreshUi($)
    // Die Pane zusätzlich zum Text; nicht abgewartet, Fehler und `isPlaced: false` bleiben still.
    void safeUi(() => $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true }))
    return ownText(
      [
        t('limits'),
        t('piiState', { state, detail }),
        t('piiVersion', { version: VERSION, cc: env.cc, surfaces: env.surfaces }),
        ...surfaceLines(env.list, await surfaceSignals($, env.list)),
        t('piiToken', { set: apiKey ? t('yes') : t('no'), code }),
        t('piiHead', { state, apiUrl: shownHost(apiUrl, cfg.lang), lang: languageLine(), preset: preset ? t('presetPart', { preset: shownPreset(preset, cfg.lang) }) : '' }),
        t('piiStats', { scanned: s.scanned, replaced: v.replaced, values: Object.keys(v.byToken).length, types, encoded: s.encoded ?? 0 }),
        t('piiWithheld', { withheld: s.withheld, leaks: s.leaks, blocked: s.blocked }),
        t('piiSwitches', { shell: shownSwitch('shell_guard', shellGuard, cfg.lang), encoded: shownSwitch('encoded_runs', cfg.encodedRuns, cfg.lang), leak: shownSwitch('leak_guard', leakGuard, cfg.lang), files: shownSwitch('file_values', cfg.fileValues, cfg.lang) }),
        // Nur die Anzahl: Pfade können Namen tragen (akte-berg.txt), und /pii erscheint auf jeder Oberfläche.
        t('piiTainted', { n: tainted.length, list: '' }),
        t('piiWarm', { warm: s.warm ? Object.entries(s.warm).map(([l, r]) => `${l === 'account' ? l : shownLanguage(l, cfg.lang)} ${codeText(r, l)}`).join(' · ') : t('warmNone') }),
        t('piiRate', { n: inWindow, limit: RATE_LIMIT, plan }),
        // 2.4: `session.start` bekommt kein Signal für eine fortgesetzte Sitzung.
        t('piiResume'),
        s.lastError && !setupErrorResolved(s.lastError, st.state) ? t('piiLastError', { err: codeText(s.lastError) }) : t('piiNoError'),
      ].join('\n'),
    )
  })

  // ── Firewall-Seitenleiste und Sperr-Band ────────────────────────
  // Gezeichnet wird nur, was `paneModel`/`bandText` aus Zustand und Zählern machen: kein Klarwert,
  // kein Platzhalter, kein Token. Scheitert etwas, zeichnet der Mod nichts (`next(e)`).

  type Make = (p: Record<string, unknown>) => never
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    try {
      const m = paneModel(await paneInput($))
      const { Box, Text, Button } = $.ui.resolve(e) as unknown as Record<'Box' | 'Text' | 'Button', Make>
      return Box({
        flexDirection: 'column',
        children: [
          ...m.lines.map((line, i) => Text({ key: `l${i}`, dimColor: i === 0, children: line })),
          Box({
            key: 'footer',
            flexDirection: 'row',
            children: [
              Text({ key: 'focus', dimColor: true, children: `${m.footer.focus} ` }),
              Button({ key: 'recheck', label: m.footer.label, hotkey: m.footer.hotkey, plain: true, onPress: () => void recheck($) }),
              Text({ key: 'close', dimColor: true, children: ` · ${m.footer.close}` }),
            ],
          }),
        ],
      })
    } catch {
      return next(e)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const line = bandText(currentStatus(), cfg.lang)
      if (!line) return next(e)
      const { Box, Text } = $.ui.resolve(e) as unknown as Record<'Box' | 'Text', Make>
      return Box({ children: [Text({ key: 'band', color: 'warning', children: line })] })
    } catch {
      return next(e)
    }
  })

  // ── 1. Jede Zeile vor dem Speichern und Senden ───────────────────────────

  on('session.append', { door: ['prompt', 'command', 'tool-result', 'tool-message', 'delivery', 'attachment', 'hook-context', 'compaction', 'note', 'queue'] }, async ($, e, next) => {
    const origin = originKind(e.origin)
    void safeUi(() => $.ui.log(`anonym.legal: Zeile ${e.door}${e.message.name ? `/${e.message.name}` : ''} (${origin ?? '?'})`, { to: 'debug' }))
    if (!worthRow(e.door, e.message.name, origin)) return next(e)
    // Die drei Zeilen eines eigenen Befehls gehen ungeprüft durch (0.9): sonst hält der Mod ohne Token seine
    // eigene Auskunft zurück. Nur die genauen Formen, siehe `ownCommandText`.
    if (e.door === 'command' && ownCommandRow(e.message.content)) return next(e)
    let content: Block[]
    try {
      content = await scrubBlocks($, e.message.content as Block[])
    } catch (err) {
      const reason = shownError(err)
      const code = storedCode(err)
      await note($, (s) => ({ ...s, withheld: s.withheld + 1, lastError: code }))
      void safeUi(() => $.ui.log(t('logWithheld', { door: e.door, err: reason })))
      return next({ ...e, message: { ...e.message, content: withheld(e.message.content as Block[]) } })
    }
    await note($, (s) => ({ ...s, scanned: s.scanned + 1 }))
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) =>
    next.called ? next(e) : next({ ...e, message: { ...e.message, content: withheld(e.message.content as Block[]) } }),
  )

  // ── 2. Der Prompt: vorab prüfen, bei Fehler nicht senden ─────────────────

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    if (!apiKey) return { drop: t('dropNoKey', { next: nextStep('no_key') }) }
    if (cfg.urlProblem) return { drop: t('dropUrl', { problem: cfg.urlProblem }) }
    try {
      await scrub($, e.text, true)
    } catch (err) {
      // Der nächste Schritt aus dem Ausgang DIESER Anfrage; eine eigene Grenze oder Sprachfrage nennt /pii.
      const e = err as CheckError
      const reason = e?.checkReason ?? (e?.checkStatus === undefined ? undefined : reasonOf(e.checkStatus))
      return { drop: t('dropFailed', { err: shownError(err), next: nextStep(reason) }) }
    }
    return next({ ...e, context: [...(e.context ?? []), t('hint')] })
  }).catch(($, e, next) => (next.called ? next(e) : { drop: t('dropFailedShort', { next: nextStep(currentStatus().reason) }) }))

  // ── 3. Kontext, Anhänge, System-Prompt, Agenten, Komprimieren ────────────

  on('prompt.context', async ($, e, next) => {
    const blocks = []
    for (const b of e.blocks) blocks.push(b.name === 'currentDate' || b.name === 'gitStatus' ? b : { ...b, text: await scrub($, b.text) })
    return next({ ...e, blocks })
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, blocks: e.blocks.filter((b) => b.name === 'currentDate') })))

  on('prompt.attachment', async ($, e, next) => {
    const origin = originKind(e.origin)
    void safeUi(() => $.ui.log(`anonym.legal: Anhang ${e.type} (${origin ?? '?'})`, { to: 'debug' }))
    return worthRow('attachment', e.type, origin) ? next({ ...e, text: await scrub($, e.text) }) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: null }))

  on('prompt.section', async ($, e, next) => {
    if (!SECTIONS.test(e.name) || !e.text) return next(e)
    return next({ ...e, text: await scrub($, e.text) })
  }).catch(($, e, next) => (next.called ? next(e) : SECTIONS.test(e.name) ? { text: null } : next(e)))

  on('session.send', async ($, e, next) => next({ ...e, text: await scrub($, e.text) })).catch(($, e, next) =>
    next.called ? next(e) : { isDelivered: false, reason: refused($, 'send', t('sendReason')) },
  )

  on('session.compact', async ($, e, next) =>
    e.instructions ? next({ ...e, instructions: await scrub($, e.instructions) }) : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : next({ ...e, instructions: undefined })))

  // ── 4. Lokale Werkzeuge bekommen die echten Werte ────────────────────────

  on('tool.call', { tool: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] }, async ($, e, next) => {
    // Streng-Modus: schreibende Werkzeuge mit Platzhaltern laufen nicht, statt
    // echte Werte auf die Platte zu schreiben. Lesen und Suchen bekommen weiter echte Werte.
    if (cfg.fileValues === 'deny' && WRITERS.has(String(e.tool)) && leftoverTokens(Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))).length) {
      return { deny: refused($, 'files', STRICT_FILES()) }
    }
    const r = await restoreArgs($, e)
    if ('leftover' in r) return { deny: refused($, 'files', LEFTOVER(r.leftover)) }
    // Markieren, nur Auskunft: hat das Zurückübersetzen Werte einer schreibenden Datei
    // geändert, steht ihr Pfad in `tainted`. Verglichen werden die Werte, nicht die Objekte.
    if (WRITERS.has(String(e.tool)) && JSON.stringify(r) !== JSON.stringify(e)) {
      const path = String((e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path ?? '')
      if (path) await update($, taintedAtom, (t) => (t.includes(path) ? t : [...t, path]))
    }
    return next(r)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: refused($, 'files', RESTORE_FAILED()) }))
  if (detokenizeBash) {
    on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
      // Streng-Modus: auch ein Befehl setzt keine echten Werte ein (sonst schriebe `echo … > datei` sie doch).
      if (cfg.fileValues === 'deny' && leftoverTokens(Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))).length) {
        return { deny: refused($, 'files', STRICT_FILES()) }
      }
      const r = await restoreArgs($, e)
      return 'leftover' in r ? { deny: refused($, 'files', LEFTOVER(r.leftover)) } : next(r)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: refused($, 'files', RESTORE_FAILED()) }))
  }

  // ── 4b. Befehle: ablehnen und nachfragen ──────────────────────────
  // Ein Hook auf `tool.check`: er trägt den Befehlstext (`input.command`, die Typdatei) und
  // kennt `ask` und `deny`; wo niemand gefragt werden kann, wird `ask` zum
  // `deny`. `.catch` lehnt ab: an `tool.check` ist noch nichts gelaufen.

  if (shellGuard !== 'off') {
    on('tool.check', { tool: ['Bash', 'PowerShell', 'Monitor'] }, async ($, e, next) => {
      const command = commandOf(e.tool, e.input)
      const v = command === undefined ? undefined : shellVerdict(command, cfg.lang)
      if (!v) return next(e)
      const action = shellGuard === 'ask' ? 'ask' : v.action
      void safeUi(() => $.ui.log(t(action === 'deny' ? 'logShellDenied' : 'logShellAsk', { reason: v.reason })))
      if (action === 'deny') return { decision: 'deny', reason: refused($, 'shell', `${t('shellDenied', { reason: v.reason })} ${t('notALock')}`) }
      const below = await next(e)
      return below.decision === 'deny' ? below : { decision: 'ask', reason: `${t('shellAsk', { reason: v.reason })} ${t('notALock')}` }
    }).catch(($) => ({ decision: 'deny', reason: refused($, 'shell', `${t('shellCheckFailed')} ${t('notALock')}`) }))
  }

  // ── 4c. Ausgänge: Werkzeuge ohne echte Werte ─────────────
  // Sie bekommen Platzhalter. Steht in ihren Argumenten doch ein bekannter Wert im Klartext oder
  // kodiert, wird der Aufruf abgelehnt. Lokal, ohne Anfrage an anonym.legal.

  if (leakGuard !== 'off') {
    // Umgekehrte Liste: JEDES Werkzeug wird geprüft, außer denen, die echte Werte bekommen. Eine
    // Positivliste übersah Werkzeuge, die nach außen gehen (SendFeedback, SendFile, RemoteTrigger …).
    const local = detokenizeBash ? 'Read|Write|Edit|NotebookEdit|Glob|Grep|Bash|PowerShell' : 'Read|Write|Edit|NotebookEdit|Glob|Grep'
    const egress = new RegExp(`^(?!(?:${local})$)`)
    on('tool.call', { tool: egress }, async ($, e, next) => {
      const args = Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))
      const leak = findLeak(JSON.stringify(args), await read($, vaultAtom))
      if (!leak) return next(e)
      const stop = leakGuard === 'block' && leak.strong
      await note($, (s) => ({ ...s, leaks: s.leaks + 1, blocked: s.blocked + (stop ? 1 : 0) }))
      void safeUi(() => $.ui.log(t(stop ? 'logEgressStop' : 'logEgressNote', { tool: String(e.tool), token: shownToken(leak.token, cfg.lang) })))
      return stop ? { deny: refused($, 'egress', `${EGRESS_STOPPED()} (${shownToken(leak.token, cfg.lang)}). ${t('notALock')}`, true) } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : leakGuard === 'block' ? { deny: refused($, 'egress', `${EGRESS_STOPPED()} (${t('checkFailed')}). ${t('notALock')}`) } : next(e)))
  }

  // ── 5. Anzeige für den Menschen ──────────────────────────────────────────

  // Echte Werte nur auf einer lokalen Oberfläche (`mayRevealOnSurface`). Auf einer entfernten
  // (Remote Control über Anthropic, Desktop/VS Code ohne Lokal-Signal, unbekannte Namen) zeigen Nachrichten
  // UND Werkzeugzeilen Platzhalter: lokale Werkzeuge tragen nach 4. echte Werte in Argumenten und Ergebnis,
  // darum werden bekannte Werte dort rekursiv zurück in Platzhalter gesetzt.
  // Fehlerpfad: alles Fehleranfällige läuft VOR dem einzigen `next`; danach wirft nichts mehr. Scheitert es,
  // geht auf dem Terminal das Original weiter (`next(e)`), auf einer entfernten Oberfläche nur ein Hinweis
  // ohne Inhalt (das Original einer Werkzeugzeile trüge Klarwerte). Der `.catch` folgt derselben Regel; ein
  // dort wiederholtes `next` gibt nur zurück, was schon für diese Oberfläche bereinigt war.
  on('ui.render', { component: SHOWN }, async ($, e, next) => {
    // `desktop` hängt an der aktuellen Liste der Oberflächen; die anderen brauchen sie nicht.
    const sig = String(e.surface) === 'desktop' ? await surfaceSignals($) : {}
    const reveal = mayRevealOnSurface(String(e.surface), sig)
    return renderGuarded({ original: e, reveal, prepare: (x) => shownOn($, x, reveal), next, withheld: withheldRender })
  }).catch(($, e, next) => {
    // Schon weitergereicht (`next.called`): kein zweites `next`; der Fehler bleibt, das bereinigte Ergebnis steht.
    if (next.called) throw next.error
    // Ohne Liste der Oberflächen: `desktop` zählt hier als entfernt (Platzhalter).
    return mayRevealOnSurface(String(e.surface), {}) ? next(e) : withheldRender()
  })

  // ── 6. Lecksuche in jeder Anfrage ans Modell ─────────────────────────────

  if (leakGuard !== 'off') {
    on('http.fetch', async ($, e, next) => {
      if (next.origin?.plugin !== 'engine') return next(e)
      // Zählanfragen tragen ungeschwärzten Inhalt großer Werkzeug-Ergebnisse: nie hinaus (2026-11-17).
      if (isTokenCountRequest(e.url)) {
        await note($, (s) => ({ ...s, blocked: s.blocked + 1 }))
        return { deny: refused($, 'count', TOKEN_COUNT_WITHHELD(), true) }
      }
      // Geprüft werden URL und Körper; eine Anfrage ohne Körper über die URL allein.
      const leak = requestLeak(e.url, e.init?.body, await read($, vaultAtom))
      if (leak && 'unreadable' in leak) return leakGuard === 'block' ? { deny: refused($, 'request', `${LEAK_STOPPED()} (${t('bodyUnreadable')})`) } : next(e)
      if (!leak) return next(e)
      if (leakGuard === 'block' && leak.strong) {
        // Erst ersetzen, dann neu prüfen (0.7.2): ein Klarwert im Verlauf darf die Sitzung nicht für immer sperren.
        const vault = await read($, vaultAtom)
        const scrubbed = scrubRequestBody(e.init?.body, vault)
        if (scrubbed) {
          const rest = requestLeak(e.url, scrubbed.body, scrubbed.vault)
          if (!rest || (!('unreadable' in rest) && !rest.strong)) {
            if (scrubbed.vault !== vault) await update($, vaultAtom, (old) => (old === vault ? scrubbed.vault : old))
            await note($, (s) => ({ ...s, leaks: s.leaks + 1, rewritten: (s.rewritten ?? 0) + 1 }))
            void safeUi(() => $.ui.log(t('logLeakRewritten', { token: shownToken(leak.token, cfg.lang), count: scrubbed.count })))
            return next({ ...e, init: { ...e.init, body: scrubbed.body } } as typeof e)
          }
        }
      }
      const stop = leakGuard === 'block' && leak.strong
      await note($, (s) => ({ ...s, leaks: s.leaks + 1, blocked: s.blocked + (stop ? 1 : 0) }))
      void safeUi(() => $.ui.log(t(stop ? 'logLeakStop' : 'logLeakNote', { token: shownToken(leak.token, cfg.lang) })))
      return stop ? { deny: refused($, 'request', LEAK_STOPPED(), true) } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : leakGuard === 'block' ? { deny: refused($, 'request', `${LEAK_STOPPED()} (${t('checkFailed')})`) } : next(e)))
  }
}
