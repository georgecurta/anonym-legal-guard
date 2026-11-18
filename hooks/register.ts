// anonym.legal PII-Schutzschicht für Claude Code (Prototyp v0.6).
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
// Treffer der API-eigenen Websuche. Siehe README.

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
  ENCODED_WITHHELD,
  findLeak,
  isTokenCountRequest,
  requestLeak,
  leftoverTokens,
  newTag,
  NOT_A_LOCK,
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
  type Entity,
} from './core'

type Block = { type: string; [field: string]: unknown }

/** Fassung des Mods; muss zu `.claude-plugin/plugin.json` passen (der Mod liest keine Dateien). */
export const VERSION = '0.6.2'
const CLIENT = `ClaudeCodeMod/${VERSION}`

const vaultAtom = atom({ plugin: 'anonym-legal-guard', key: 'vault' } as const, emptyVault(), { shape: 'vault-3' })
const statsAtom = atom({ plugin: 'anonym-legal-guard', key: 'stats' } as const, { scanned: 0, withheld: 0, leaks: 0, blocked: 0 } as GuardStats, {
  shape: 'stats-2',
})

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

const WITHHELD = '[anonym.legal: Inhalt zurückgehalten, die PII-Prüfung ist fehlgeschlagen]'
const MEDIA_DROPPED = '[anonym.legal: Bild oder Dokument zurückgehalten, es kann nicht geschwärzt werden]'
const UNKNOWN_DROPPED = '[anonym.legal: ein Inhalt unbekannter Art wurde zurückgehalten]'
const HINT =
  'Hinweis von anonym.legal: Personenbezogene Daten erscheinen in dieser Sitzung als Platzhalter wie ‹PERSON_1·abc›. ' +
  'Das ist gewollt. Verwende die Platzhalter unverändert, auch in Dateien. Beim Schreiben von Dateien und in der Anzeige ' +
  'für den Nutzer setzt dieser Mod auf dem Rechner des Nutzers die echten Werte ein. Schreibe nicht, dass du die echten Werte nicht kennst.'

/** Felder, die die Engine setzt; sie werden nie umgeschrieben. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'requestMeta'])
/** Abschnitte des System-Prompts, die Umgebungsdaten tragen (Arbeitsordner mit Benutzername, Notizen). */
const SECTIONS = /^(env_info|memory)/

type Config = {
  apiUrl: string
  /** Warum die Adresse nicht benutzt wird; dann geht keine Anfrage hinaus und jeder Prompt wird verworfen. */
  urlProblem?: string
  apiKey: string
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
  apiUrl: 'https://anonym.legal', apiKey: '', languages: ['de'], preset: '', leakGuard: 'block', encodedRuns: 'scan', shellGuard: 'block', fileValues: 'real', media: 'drop',
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
    timer = $.clock.after(TIMEOUT_MS, () => reject(new Error(`anonym.legal antwortet nicht (Zeitgrenze ${TIMEOUT_MS / 1000} s)`)))
  })
  try {
    return await Promise.race([
      $.http.fetch(`${cfg.apiUrl}/api/mcp/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'X-Client-Version': CLIENT },
        body: JSON.stringify(body),
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
async function post($: EngineInterface, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }> {
  let paused = 0
  for (let attempt = 0; ; attempt++) {
    // Erst die Zeit holen, dann rechnen: `sent` darf nicht vor dem `await` gelesen werden, sonst
    // überschreibt bei zwei gleichzeitigen Anfragen die zweite den Eintrag der ersten.
    const now = await $.clock.now()
    const gate = rateWindow(sent, now, RATE_LIMIT, RATE_WINDOW)
    sent = gate.times
    if (gate.waitMs !== undefined) {
      throw new Error(`eigene Grenze des Mods erreicht (${RATE_LIMIT} Anfragen je 5 Minuten), nächste Anfrage in ${Math.ceil(gate.waitMs / 1000)} s`)
    }
    const res = await fetchOnce($, body)
    if (!RETRY.has(res.status) || attempt >= PAUSES.length) return res
    const wait = retryAfterMs(res) ?? PAUSES[attempt] ?? 3000
    if (paused + wait > PAUSE_BUDGET_MS) return res
    paused += wait
    await $.clock.sleep(wait)
  }
}

async function analyze($: EngineInterface, text: string): Promise<Entity[]> {
  const hit = cfg.cache.get(text)
  if (hit) return hit
  if (!cfg.apiKey) throw new Error('kein API-Schlüssel eingetragen (Option api_key)')
  if (cfg.urlProblem) throw new Error(cfg.urlProblem)
  return slot(() => analyzeNow($, text))
}

/** Text des Vorwärmens: ohne Personendaten. */
const WARM_TEXT = 'anonym.legal: Vorwärmen der Erkennung.'

/**
 * Vorwärmen: je Sprache eine kurze Anfrage, an der Warteschlange vorbei. Das Ergebnis steht in
 * `GuardStats.warm` und in `/pii`; eine Sprache, die der Server nicht kennt, zeigt sich hier zuerst.
 */
async function warm($: EngineInterface): Promise<void> {
  await Promise.all(
    cfg.languages.map(async (language) => {
      let result: string
      try {
        const r = await request($, { text: WARM_TEXT, language, output_mode: 'full' })
        result = r.language === language ? 'bereit' : `Sprache ${language} wird vom Server nicht unterstützt`
      } catch (err) {
        result = String((err as Error)?.message ?? err)
      }
      await note($, (s) => ({ ...s, warm: { ...(s.warm ?? {}), [language]: result } }))
    }),
  )
}

/** Ob der Server den Sprachplan kennt (`metadata.languages_used`), je Ladung; `undefined`: noch nicht gefragt. */
let serverPlan: boolean | undefined

type Answer = { entities: Entity[]; language?: string; languagesUsed?: string[] }

/** Warum eine Anfrage scheiterte, in einem Satz; 401, 402 und 403 nennen den Grund. */
function failure(status: number, text: string): string {
  let data: { error?: string; unsupported?: unknown; language?: string } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    // kein JSON
  }
  if (status === 401) return 'Token ungültig (HTTP 401)'
  if (status === 402) return 'Guthaben leer (HTTP 402)'
  if (status === 403) return 'Tarif ohne Zugang zum Mod (HTTP 403; der Mod gehört zu Basic, Pro und Business)'
  if (status === 400 && data.error === 'UNSUPPORTED_LANGUAGE') {
    const list = Array.isArray(data.unsupported) ? data.unsupported.map(String).join(', ') : cfg.languages.join(', ')
    return `Sprache ${list} wird vom Server nicht unterstützt (HTTP 400)`
  }
  if (status === 503 && data.error === 'LANGUAGE_CATALOG_UNAVAILABLE') return 'Sprachkatalog des Servers nicht erreichbar (HTTP 503)'
  if (status === 503 && data.error === 'MODEL_LOADING') return `Sprachmodell${data.language ? ` ${data.language}` : ''} lädt noch (HTTP 503)`
  if (status === 429) return 'Drosselung durch den Server (HTTP 429)'
  return `anonym.legal antwortet HTTP ${status}`
}

async function request($: EngineInterface, body: Record<string, unknown>): Promise<Answer> {
  const res = await post($, body)
  if (!res.ok) throw new Error(failure(res.status, res.text))
  let data: { success?: boolean; entities?: Entity[]; metadata?: { language?: unknown; languages_used?: unknown } }
  try {
    data = JSON.parse(res.text) as typeof data
  } catch {
    throw new Error('anonym.legal: Antwort nicht lesbar')
  }
  // Streng lesen: Eine Antwort, die anders aussieht als vereinbart, ist kein „nichts gefunden“.
  // Sonst ginge die Zeile bei `success: true` ohne `entities` ungeschwärzt durch.
  if (data.success !== true) throw new Error('anonym.legal: Antwort ohne success=true')
  if (!Array.isArray(data.entities)) throw new Error('anonym.legal: Antwort ohne Trefferliste (entities)')
  for (const e of data.entities) {
    if (!e || typeof e !== 'object' || typeof e.start !== 'number' || typeof e.end !== 'number' || typeof e.entity_type !== 'string') {
      throw new Error('anonym.legal: Treffer ohne Typ oder ohne Position als Zahl')
    }
  }
  const used = data.metadata?.languages_used
  return {
    entities: data.entities,
    language: typeof data.metadata?.language === 'string' ? data.metadata.language.toLowerCase() : undefined,
    languagesUsed: Array.isArray(used) ? used.map((l) => String(l).toLowerCase()) : undefined,
  }
}

const unsupported = (language: string) => new Error(`Sprache ${language} wird vom Server nicht unterstützt`)

/**
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
  if (first === undefined) throw new Error('keine gültige Sprache eingetragen (Option language)')
  const all: Entity[] = []
  const collect = (entities: readonly Entity[], start: number) => {
    for (const e of entities) {
      if (typeof e.start === 'number' && typeof e.end === 'number') all.push({ ...e, start: e.start + start, end: e.end + start })
    }
  }
  for (const { piece, start } of chunks(text, CHUNK, OVERLAP)) {
    const extra: Record<string, unknown> = cfg.preset ? { preset: cfg.preset } : {}
    const plan = await request($, { text: piece, language: first, languages: langs, output_mode: 'full', ...extra })
    collect(plan.entities, start)
    let done: Set<string>
    if (plan.languagesUsed) {
      serverPlan = true
      done = new Set(plan.languagesUsed)
    } else {
      serverPlan = false
      if (plan.language !== first) throw unsupported(first)
      done = new Set([first])
    }
    for (const language of langs) {
      if (done.has(language)) continue
      const one = await request($, { text: piece, language, output_mode: 'full', ...extra })
      if (one.language !== language) throw unsupported(language)
      collect(one.entities, start)
    }
  }
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
  return replaceSpans(text, spans, ENCODED_WITHHELD)
}

/**
 * Schwärzt einen Text: kodierte Abschnitte, bekannte Werte, dann die Treffer der Erkennung.
 * `dry` (für den Prompt vorab) schickt dieselben Anfragen, ändert aber den Vault nicht; so trifft
 * die spätere Zeile den Zwischenspeicher.
 */
async function scrub($: EngineInterface, text: string, dry = false): Promise<string> {
  // Der eigene Hinweis fürs Modell wird nicht geschwärzt (Live-Test v0.4: mit englischer Erkennung
  // wurden Wörter darin ersetzt, und der Hinweis kam verstümmelt an).
  if (text.includes(HINT)) {
    const parts = text.split(HINT)
    const out: string[] = []
    for (const p of parts) out.push(await scrub($, p, dry))
    return out.join(HINT)
  }
  if (!worthScanning(text)) return text
  const before = await vaultOf($)
  const plain = cfg.encodedRuns === 'off' ? text : await scrubEncoded($, text, before, dry)
  const swept = sweepKnown(plain, before).text
  // Ein Namens-Treffer, der selbst ein kodierter Abschnitt ist, ist ein Zufallstreffer; den
  // Abschnitt hat scrubEncoded schon geprüft (live gemessen 2026-11-16).
  const entities = (await analyze($, swept)).filter((x) => keep(x) && (cfg.encodedRuns === 'off' || !encodedNameHit(x)))
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
            if (cfg.media === 'drop') marker = MEDIA_DROPPED
            else kept.push(b)
          } else marker ||= UNKNOWN_DROPPED
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
  if (droppedTop && !out.some((b) => b.type === 'text' || b.type === 'tool_result')) out.push({ type: 'text', text: MEDIA_DROPPED })
  return out
}

/** Was statt einer Zeile gespeichert wird, deren Prüfung scheiterte: Text weg, Paarung bleibt. */
function withheld(content: readonly Block[]): Block[] {
  return content
    .map((b) => {
      if (b.type === 'text') return { ...b, text: WITHHELD }
      if (b.type === 'tool_result') return { ...b, content: WITHHELD }
      return b
    })
    .filter((b) => b.type !== 'image' && b.type !== 'document')
}

async function note($: EngineInterface, patch: (s: GuardStats) => GuardStats): Promise<void> {
  let s: GuardStats = { scanned: 0, withheld: 0, leaks: 0, blocked: 0 }
  await update($, statsAtom, (old) => (s = patch(old)))
  const v = await read($, vaultAtom)
  const warn = s.withheld > 0 || s.leaks > 0 ? ` · ${s.withheld} zurückgehalten · ${s.leaks} Leck (${s.blocked} gestoppt)` : ''
  $.ui.status(`anonym.legal: ${v.replaced} ersetzt${warn}`)
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

const LEFTOVER = (t: string[]) =>
  `anonym.legal: der Aufruf enthält Platzhalter, die sich in dieser Sitzung nicht zurückübersetzen lassen (${[...new Set(t)].slice(0, 3).join(', ')}). ` +
  `Er lief nicht, damit keine Platzhalter in Dateien landen. Das passiert nach --resume oder bei erfundenen Platzhaltern; lies die Datei neu ein. ${NOT_A_LOCK}`

/** Der Befehlstext eines Shell-Werkzeugs; ein Monitor auf eine WebSocket hat keinen. Unlesbar: wirft. */
function commandOf(tool: string, input: unknown): string | undefined {
  const c = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  if (typeof c === 'string') return c
  if (tool === 'Monitor' && c === undefined) return undefined
  throw new Error('Befehl nicht lesbar')
}

const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit'])
const STRICT_FILES =
  'anonym.legal (Streng-Modus, file_values deny): der Aufruf enthält Platzhalter. Er lief nicht, damit keine echten Werte über das Modell ' +
  `in Dateien geschrieben werden. Schreibe ohne Platzhalter oder lass den Nutzer die Werte selbst einsetzen. ${NOT_A_LOCK}`
const EGRESS_STOPPED = 'anonym.legal: Aufruf abgelehnt, ein Argument enthält einen geschwärzten Wert im Klartext'
const RESTORE_FAILED = `anonym.legal: die Platzhalter ließen sich nicht zurückübersetzen, der Aufruf lief nicht. ${NOT_A_LOCK}`
const TOKEN_COUNT_WITHHELD = `anonym.legal: Zählanfrage zurückgehalten; sie trüge Text vor dem Schwärzen. ${NOT_A_LOCK}`
const LEAK_STOPPED = `anonym.legal: die Anfrage ans Modell enthielt einen geschwärzten Wert im Klartext und wurde gestoppt. ${NOT_A_LOCK}`

export const register: Register = (on, options) => {
  cfg = {
    apiUrl: String(options.api_url ?? 'https://anonym.legal').replace(/\/+$/, ''),
    apiKey: String(options.api_key ?? ''),
    languages: parseLanguages(String(options.language ?? 'de')),
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
  cfg.urlProblem = apiUrlProblem(cfg.apiUrl, options.allow_other_host === true)
  // Erlaubte Werte („Claude“) werden auch kein Namensteil mit eigenem Platzhalter.
  setAliasDeny(cfg.allowValues)
  // Der Zähler der eigenen Grenze bleibt über ein Neuladen bestehen: sonst höbe jedes Neuladen sie auf.
  serverPlan = undefined
  active = 0
  waiting.length = 0
  const { apiUrl, apiKey, preset, leakGuard, detokenizeBash, shellGuard } = cfg
  const language = cfg.languages.join('+') || 'keine'

  // ── Sitzung und Befehl ───────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pii', description: 'anonym.legal: Stand der PII-Schutzschicht' })
    const problem = !apiKey ? 'kein API-Schlüssel, Prompts werden blockiert' : cfg.urlProblem ? `${cfg.urlProblem}, Prompts werden blockiert` : undefined
    $.ui.status(problem ? `anonym.legal: ${problem}` : 'anonym.legal: PII-Schutz aktiv')
    // Vorwärmen ohne zu warten: über einen Zeitgeber, damit die Arbeit den Start überdauert
    // (Referenz „Work that outlives a dispatch“).
    if (!problem) $.clock.after(0, () => void warm($).catch(() => undefined))
    return next(e)
  })

  on('command.run', { command: 'pii' }, async ($) => {
    const v = await read($, vaultAtom)
    const s = await read($, statsAtom)
    const tainted = await read($, taintedAtom)
    const inWindow = rateWindow(sent, await $.clock.now(), Number.MAX_SAFE_INTEGER, RATE_WINDOW).times.length - 1
    const types = Object.entries(v.counter).map(([t, n]) => `${t} ${n}`).join(', ') || 'keine'
    return {
      text: [
        'Schutz gegen Versehen, nicht gegen eingeschleuste Anweisungen und nicht gegen Absicht.',
        `anonym.legal PII-Schutz: ${!apiKey ? 'kein API-Schlüssel' : cfg.urlProblem ? `aus (${cfg.urlProblem})` : 'aktiv'} (${apiUrl}, Sprache ${language}${preset ? `, Voreinstellung ${preset}` : ''})`,
        `Geprüfte Zeilen: ${s.scanned} · ersetzt: ${v.replaced} · verschiedene Werte: ${Object.keys(v.byToken).length} (${types}) · kodierte Abschnitte ersetzt: ${s.encoded ?? 0}`,
        `Zurückgehalten: ${s.withheld} · Lecks in Anfragen: ${s.leaks}, davon gestoppt ${s.blocked}`,
        `Schalter: shell_guard ${shellGuard} · encoded_runs ${cfg.encodedRuns} · leak_guard ${leakGuard} · file_values ${cfg.fileValues}`,
        `Markierte Dateien: ${tainted.length} (der Mod hat dort beim Schreiben echte Werte eingesetzt)${tainted.length ? `: ${tainted.slice(0, 5).join(', ')}${tainted.length > 5 ? ' …' : ''}` : ''}`,
        `Vorwärmen: ${s.warm ? Object.entries(s.warm).map(([l, r]) => `${l} ${r}`).join(' · ') : 'noch kein Ergebnis'}`,
        `Anfragen im 5-Minuten-Fenster: ${inWindow} von ${RATE_LIMIT} · Sprachplan des Servers: ${serverPlan === undefined ? 'noch nicht gefragt' : serverPlan ? 'ja' : 'nein, Sprachen werden einzeln nachgeholt'}`,
        // 2.4: `session.start` bekommt kein Signal für eine fortgesetzte Sitzung.
        'Die Zuordnung gilt nur für diese Sitzung. Nach `--resume` lassen sich alte Platzhalter nicht zurückübersetzen; Schreiben damit wird abgelehnt.',
        s.lastError ? `Letzter Fehler: ${s.lastError}` : 'Kein Fehler.',
      ].join('\n'),
    }
  })

  // ── 1. Jede Zeile vor dem Speichern und Senden ───────────────────────────

  on('session.append', { door: ['prompt', 'command', 'tool-result', 'tool-message', 'delivery', 'attachment', 'hook-context', 'compaction', 'note', 'queue'] }, async ($, e, next) => {
    const origin = originKind(e.origin)
    $.ui.log(`anonym.legal: Zeile ${e.door}${e.message.name ? `/${e.message.name}` : ''} (${origin ?? '?'})`, { to: 'debug' })
    if (!worthRow(e.door, e.message.name, origin)) return next(e)
    let content: Block[]
    try {
      content = await scrubBlocks($, e.message.content as Block[])
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      await note($, (s) => ({ ...s, withheld: s.withheld + 1, lastError: msg }))
      $.ui.log(`anonym.legal: eine Zeile (${e.door}) wurde zurückgehalten: ${msg}`)
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
    if (!apiKey) return { drop: 'anonym.legal: kein API-Schlüssel eingetragen, der Prompt wurde nicht gesendet. /plugin → anonym-legal-guard → Configure.' }
    if (cfg.urlProblem) return { drop: `anonym.legal: ${cfg.urlProblem}. Der Prompt wurde nicht gesendet. /plugin → anonym-legal-guard → Configure.` }
    try {
      await scrub($, e.text, true)
    } catch (err) {
      return { drop: `anonym.legal: die PII-Prüfung ist fehlgeschlagen (${String((err as Error)?.message ?? err)}), der Prompt wurde nicht gesendet.` }
    }
    return next({ ...e, context: [...(e.context ?? []), HINT] })
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'anonym.legal: die PII-Prüfung ist fehlgeschlagen, der Prompt wurde nicht gesendet.' }))

  // ── 3. Kontext, Anhänge, System-Prompt, Agenten, Komprimieren ────────────

  on('prompt.context', async ($, e, next) => {
    const blocks = []
    for (const b of e.blocks) blocks.push(b.name === 'currentDate' || b.name === 'gitStatus' ? b : { ...b, text: await scrub($, b.text) })
    return next({ ...e, blocks })
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, blocks: e.blocks.filter((b) => b.name === 'currentDate') })))

  on('prompt.attachment', async ($, e, next) => {
    const origin = originKind(e.origin)
    $.ui.log(`anonym.legal: Anhang ${e.type} (${origin ?? '?'})`, { to: 'debug' })
    return worthRow('attachment', e.type, origin) ? next({ ...e, text: await scrub($, e.text) }) : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { text: null }))

  on('prompt.section', async ($, e, next) => {
    if (!SECTIONS.test(e.name) || !e.text) return next(e)
    return next({ ...e, text: await scrub($, e.text) })
  }).catch(($, e, next) => (next.called ? next(e) : SECTIONS.test(e.name) ? { text: null } : next(e)))

  on('session.send', async ($, e, next) => next({ ...e, text: await scrub($, e.text) })).catch(($, e, next) =>
    next.called ? next(e) : { isDelivered: false, reason: 'anonym.legal: die PII-Prüfung ist fehlgeschlagen' },
  )

  on('session.compact', async ($, e, next) =>
    e.instructions ? next({ ...e, instructions: await scrub($, e.instructions) }) : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : next({ ...e, instructions: undefined })))

  // ── 4. Lokale Werkzeuge bekommen die echten Werte ────────────────────────

  on('tool.call', { tool: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] }, async ($, e, next) => {
    // Streng-Modus: schreibende Werkzeuge mit Platzhaltern laufen nicht, statt
    // echte Werte auf die Platte zu schreiben. Lesen und Suchen bekommen weiter echte Werte.
    if (cfg.fileValues === 'deny' && WRITERS.has(String(e.tool)) && leftoverTokens(Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))).length) {
      return { deny: STRICT_FILES }
    }
    const r = await restoreArgs($, e)
    if ('leftover' in r) return { deny: LEFTOVER(r.leftover) }
    // Markieren, nur Auskunft: hat das Zurückübersetzen Werte einer schreibenden Datei
    // geändert, steht ihr Pfad in `tainted`. Verglichen werden die Werte, nicht die Objekte.
    if (WRITERS.has(String(e.tool)) && JSON.stringify(r) !== JSON.stringify(e)) {
      const path = String((e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path ?? '')
      if (path) await update($, taintedAtom, (t) => (t.includes(path) ? t : [...t, path]))
    }
    return next(r)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: RESTORE_FAILED }))
  if (detokenizeBash) {
    on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
      // Streng-Modus: auch ein Befehl setzt keine echten Werte ein (sonst schriebe `echo … > datei` sie doch).
      if (cfg.fileValues === 'deny' && leftoverTokens(Object.fromEntries(Object.entries(e).filter(([k]) => !RESERVED.has(k)))).length) {
        return { deny: STRICT_FILES }
      }
      const r = await restoreArgs($, e)
      return 'leftover' in r ? { deny: LEFTOVER(r.leftover) } : next(r)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: RESTORE_FAILED }))
  }

  // ── 4b. Befehle: ablehnen und nachfragen ──────────────────────────
  // Ein Hook auf `tool.check`: er trägt den Befehlstext (`input.command`, die Typdatei) und
  // kennt `ask` und `deny`; wo niemand gefragt werden kann, wird `ask` zum
  // `deny`. `.catch` lehnt ab: an `tool.check` ist noch nichts gelaufen.

  if (shellGuard !== 'off') {
    on('tool.check', { tool: ['Bash', 'PowerShell', 'Monitor'] }, async ($, e, next) => {
      const command = commandOf(e.tool, e.input)
      const v = command === undefined ? undefined : shellVerdict(command)
      if (!v) return next(e)
      const action = shellGuard === 'ask' ? 'ask' : v.action
      $.ui.log(`anonym.legal: Befehl ${action === 'deny' ? 'abgelehnt' : 'nachgefragt'} (${v.reason}).`)
      if (action === 'deny') return { decision: 'deny', reason: `anonym.legal: Befehl abgelehnt (${v.reason}). ${NOT_A_LOCK}` }
      const below = await next(e)
      return below.decision === 'deny' ? below : { decision: 'ask', reason: `anonym.legal: Befehl braucht deine Bestätigung (${v.reason}). ${NOT_A_LOCK}` }
    }).catch(() => ({ decision: 'deny', reason: `anonym.legal: die Befehlsprüfung ist fehlgeschlagen, der Befehl lief nicht. ${NOT_A_LOCK}` }))
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
      $.ui.log(`anonym.legal: ${String(e.tool)} sollte den Klartext zu ${leak.token} bekommen${stop ? ', Aufruf abgelehnt' : ' (nur gemeldet)'}.`)
      return stop ? { deny: `${EGRESS_STOPPED} (${leak.token}). ${NOT_A_LOCK}` } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : leakGuard === 'block' ? { deny: `${EGRESS_STOPPED} (Prüfung fehlgeschlagen). ${NOT_A_LOCK}` } : next(e)))
  }

  // ── 5. Anzeige für den Menschen ──────────────────────────────────────────

  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    const v = await read($, vaultAtom)
    const text = (e.props as { text: string }).text
    const plain = detokenize(text, v)
    return plain === text ? next(e) : next({ ...e, props: { ...e.props, text: plain } } as typeof e)
  })

  // ── 6. Lecksuche in jeder Anfrage ans Modell ─────────────────────────────

  if (leakGuard !== 'off') {
    on('http.fetch', async ($, e, next) => {
      if (next.origin?.plugin !== 'engine') return next(e)
      // Zählanfragen tragen ungeschwärzten Inhalt großer Werkzeug-Ergebnisse: nie hinaus (2026-11-17).
      if (isTokenCountRequest(e.url)) {
        await note($, (s) => ({ ...s, blocked: s.blocked + 1 }))
        return { deny: TOKEN_COUNT_WITHHELD }
      }
      // Geprüft werden URL und Körper; eine Anfrage ohne Körper über die URL allein.
      const leak = requestLeak(e.url, e.init?.body, await read($, vaultAtom))
      if (leak && 'unreadable' in leak) return leakGuard === 'block' ? { deny: `${LEAK_STOPPED} (Körper nicht lesbar)` } : next(e)
      if (!leak) return next(e)
      const stop = leakGuard === 'block' && leak.strong
      await note($, (s) => ({ ...s, leaks: s.leaks + 1, blocked: s.blocked + (stop ? 1 : 0) }))
      $.ui.log(`anonym.legal: in einer Anfrage ans Modell steht der Klartext zu ${leak.token}${stop ? ', Anfrage gestoppt' : ' (nur gemeldet)'}.`)
      return stop ? { deny: LEAK_STOPPED } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : leakGuard === 'block' ? { deny: `${LEAK_STOPPED} (Prüfung fehlgeschlagen)` } : next(e)))
  }
}
