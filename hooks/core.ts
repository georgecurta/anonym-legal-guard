// Reiner Kern der PII-Schutzschicht: Platzhalter vergeben, einsetzen und zurückübersetzen.
// Kein `$`, kein Netz: alles hier ist mit festen Eingaben testbar.

import type { Vault } from '../types'
import { msg, type Lang } from './messages'

/** Ein Treffer der Erkennung, wie `/api/mcp/analyze` ihn liefert: Offsets in Codepunkten. */
export type Entity = { entity_type: string; start?: number; end?: number; text: string; score: number }

/**
 * Platzhalter: ‹TYP_n·tag›. `tag` ist je Sitzung zufällig. So trifft ein Text, der zufällig wie ein
 * Platzhalter aussieht (etwa diese Doku), nie einen echten Wert, und kein solcher Text ist von der
 * Erkennung ausgenommen.
 */
export const TOKEN = /‹([A-Z][A-Z0-9_]*?)_(\d+)·([a-z0-9]{3})›/g

/** Typen, deren einzelne Wörter zu mehrdeutig sind, um eine Anfrage wegen eines Lecks zu stoppen. */
const WEAK_TYPES = new Set(['PERSON', 'LOCATION', 'ORGANIZATION', 'NRP', 'DATE_TIME', 'URL'])

export const emptyVault = (tag = ''): Vault => ({ tag, byValue: {}, byToken: {}, counter: {}, aliases: {}, replaced: 0 })

/** Ein neuer Sitzungs-Tag aus drei Zeichen. */
export function newTag(random: (n: number) => Uint8Array): string {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789'
  return Array.from(random(3), (b) => abc[b % abc.length]).join('')
}

/** Werte, die nie ein Namensteil mit eigenem Platzhalter werden (Option `allow_values`, kleingeschrieben). */
let aliasDeny: ReadonlySet<string> = new Set()
export function setAliasDeny(values: ReadonlySet<string>): void {
  aliasDeny = values
}

/** Der Platzhalter für einen Wert: derselbe Wert ergibt in einer Sitzung immer denselben. */
export function tokenFor(vault: Vault, type: string, value: string): { vault: Vault; token: string; isNew: boolean } {
  const key = `${type}\u0000${value}`
  const known = vault.byValue[key]
  if (known) return { vault, token: known, isNew: false }
  const n = (vault.counter[type] ?? 0) + 1
  const token = `‹${type}_${n}·${vault.tag}›`
  // Ein Name kommt oft verkürzt wieder („Frau Mustermann“): jeder großgeschriebene Teil ab 3
  // Zeichen bekommt denselben Platzhalter, solange ihn noch kein anderer Name hat. Ersetzt wird
  // nur an Wortgrenzen, „Annahme“ bleibt also „Annahme“.
  // Nicht für Teile unter 4 Zeichen, erlaubte Werte („Claude“) und Befehlswörter: Ein solcher Teil
  // steht in jeder Sitzung irgendwo, und die Lecksuche fände ihn in jeder Anfrage (Prüfung 2026-11-16).
  const aliases = { ...(vault.aliases ?? {}) }
  if (type === 'PERSON') {
    for (const part of value.split(/\s+/)) {
      if (part === value || part in aliases) continue
      if (!/^\p{Lu}[\p{L}'-]{3,}$/u.test(part) || aliasDeny.has(part.toLowerCase()) || NOT_NAMES.has(part)) continue
      aliases[part] = token
    }
  }
  return {
    token,
    isNew: true,
    vault: {
      ...vault,
      byValue: { ...vault.byValue, [key]: token },
      byToken: { ...vault.byToken, [token]: value },
      counter: { ...vault.counter, [type]: n },
      aliases,
    },
  }
}

/** Typ eines Platzhalters, z. B. PERSON aus ‹PERSON_2·k7p›. */
export function typeOf(token: string): string {
  return token.replace(/^‹/, '').replace(/_\d+·[a-z0-9]{3}›$/, '')
}

/** Die bekannten Originalwerte, längste zuerst, damit „Anna Berg“ vor „Anna“ ersetzt wird. */
export function knownValues(vault: Vault): Array<{ value: string; token: string; isAlias: boolean }> {
  return [
    ...Object.entries(vault.byToken).map(([token, value]) => ({ value, token, isAlias: false })),
    ...Object.entries(vault.aliases ?? {}).map(([value, token]) => ({ value, token, isAlias: true })),
  ]
    .filter(({ value }) => value.length >= 3)
    .sort((a, b) => b.value.length - a.value.length)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Ein Wert als ganzes Wort: kein Buchstabe und keine Ziffer direkt davor oder danach. */
const wordRe = (value: string, flags = 'gu') => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`, flags)

/**
 * Ersetzt jeden schon bekannten Originalwert an Wortgrenzen, auch wo die Erkennung ihn diesmal
 * übersieht. Mehrteilige Werte und starke Typen auch in anderer Groß- und Kleinschreibung:
 * der gefundene Text bekommt über `tokenFor` einen eigenen Platzhalter, damit die Rückübersetzung
 * die Schreibweise einsetzt, die im Text stand. Einzelwörter und Namensteile bleiben
 * schreibungsgenau, sonst würde „berg“ zu einem Namen. Gibt den Vault mit den neuen Platzhaltern zurück.
 */
export function sweepKnown(text: string, vault: Vault): { text: string; vault: Vault; count: number } {
  let out = text
  let lower = text.toLowerCase()
  let v = vault
  let count = 0
  for (const { value, token, isAlias } of knownValues(vault)) {
    const ci = caseFree(value, token, isAlias)
    if (ci ? !lower.includes(value.toLowerCase()) : !out.includes(value)) continue
    const type = typeOf(token)
    const next = out.replace(wordRe(value, ci ? 'giu' : 'gu'), (found: string) => {
      count++
      if (found === value) return token
      const t = tokenFor(v, type, found)
      v = t.vault
      return t.token
    })
    if (next !== out) {
      out = next
      lower = out.toLowerCase()
    }
  }
  return { text: out, vault: v, count }
}

/**
 * Setzt die Treffer der Erkennung als Platzhalter ein. Die Offsets zählen Codepunkte
 * der Erkennung, nicht UTF-16-Einheiten. Überlappende Treffer: der frühere
 * gewinnt. Ein Treffer in einem Platzhalter dieser Sitzung wird übergangen. Passt ein Offset nicht
 * zum gemeldeten Text, wird der gemeldete Text an Wortgrenzen ersetzt, statt falsch zu schneiden.
 */
export function applyEntities(text: string, entities: readonly Entity[], vault: Vault): { text: string; vault: Vault; count: number; mismatched: number } {
  const cps = Array.from(text)
  const inToken = new Array<boolean>(cps.length).fill(false)
  const unitToCp: number[] = []
  {
    let cp = 0
    let unit = 0
    for (const ch of cps) {
      for (let k = 0; k < ch.length; k++) unitToCp[unit + k] = cp
      unit += ch.length
      cp++
    }
    for (const m of text.matchAll(TOKEN)) {
      if (m[3] !== vault.tag) continue
      const from = unitToCp[m.index ?? 0] ?? 0
      const to = unitToCp[(m.index ?? 0) + m[0].length - 1] ?? from
      for (let i = from; i <= to; i++) inToken[i] = true
    }
  }
  const fallback: Array<{ type: string; value: string }> = []
  const spans: Array<{ type: string; start: number; end: number }> = []
  for (const e of entities) {
    if (typeof e.start !== 'number' || typeof e.end !== 'number' || e.end <= e.start) continue
    const type = normalizeType(e.entity_type)
    const start = e.start
    const end = Math.min(e.end, cps.length)
    if (start >= cps.length || inToken.slice(start, end).some(Boolean)) continue
    const slice = cps.slice(start, end).join('')
    if (e.text && slice !== e.text) {
      fallback.push({ type, value: e.text })
      continue
    }
    spans.push({ type, start, end })
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)

  let v = vault
  let count = 0
  let cursor = 0
  const out: string[] = []
  for (const s of spans) {
    if (s.start < cursor) continue
    const value = cps.slice(s.start, s.end).join('')
    if (!value.trim()) continue
    const t = tokenFor(v, s.type, value)
    v = t.vault
    out.push(cps.slice(cursor, s.start).join(''), t.token)
    cursor = s.end
    count++
  }
  out.push(cps.slice(cursor).join(''))
  let result = out.join('')
  for (const f of fallback) {
    if (!f.value.trim() || !result.includes(f.value)) continue
    const t = tokenFor(v, f.type, f.value)
    v = t.vault
    result = result.replace(wordRe(f.value), () => {
      count++
      return t.token
    })
  }
  return { text: result, vault: v, count, mismatched: fallback.length }
}

/** Setzt für jeden Platzhalter dieser Sitzung den echten Wert ein; fremde und unbekannte bleiben stehen. */
export function detokenize(text: string, vault: Vault): string {
  if (!text.includes('‹')) return text
  return text.replace(TOKEN, (whole: string, _t: string, _n: string, tag: string) => (tag === vault.tag ? (vault.byToken[whole] ?? whole) : whole))
}

/**
 * Platzhalter, die nach dem Zurückübersetzen noch stehen: fremder Tag oder dieser Sitzung unbekannt.
 * So etwas darf nie in eine Datei geschrieben werden. Es kommt vor, wenn eine Sitzung mit `--resume`
 * fortgesetzt wird (der Vault in `$.state` lebt nur so lange wie die Sitzung) oder wenn das Modell
 * einen Platzhalter erfindet.
 */
export function leftoverTokens(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(TOKEN)) out.push(m[0])
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(value)
  return out
}

/** Die Sprachen der Erkennung aus der Option: gültige Codes, `auto` gibt es beim Analyzer nicht. */
export function parseLanguages(option: string): string[] {
  const list = option.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
  // `auto` ist kein Sprachcode der Erkennung; es wird zu Deutsch und Englisch.
  const expanded = list.flatMap((l) => (l === 'auto' ? ['de', 'en'] : [l]))
  return [...new Set(expanded)].filter((l) => /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(l)).slice(0, 3)
}

/** Kontomodus: die Option ist leer oder `account`; der Mod schickt dann keine Sprache, der Server nimmt die des Kontos. */
export function isAccountOption(option: string): boolean {
  const v = option.trim().toLowerCase()
  return v === '' || v === 'account'
}

/** Zurückübersetzen in einem beliebigen JSON-Wert: jede Zeichenkette, auch verschachtelt. */
export function detokenizeDeep<T>(value: T, vault: Vault): T {
  if (typeof value === 'string') return detokenize(value, vault) as T
  if (Array.isArray(value)) return value.map((v) => detokenizeDeep(v, vault)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = detokenizeDeep(v, vault)
    return out as T
  }
  return value
}

/**
 * Teilt langen Text in Stücke von höchstens `max` Codepunkten, die sich um `overlap` überlappen,
 * bevorzugt an Zeilen- oder Wortgrenzen. Ein Treffer über einer Grenze liegt so ganz in einem Stück
 * . `start` ist der Codepunkt, an dem das Stück im ganzen Text beginnt.
 */
export function chunks(text: string, max: number, overlap = 0): Array<{ piece: string; start: number }> {
  const cps = Array.from(text)
  if (cps.length <= max) return [{ piece: text, start: 0 }]
  const out: Array<{ piece: string; start: number }> = []
  let start = 0
  while (start < cps.length) {
    let end = Math.min(start + max, cps.length)
    if (end < cps.length) {
      const nl = cps.lastIndexOf('\n', end - 1)
      const sp = cps.lastIndexOf(' ', end - 1)
      const cut = nl > start + max / 2 ? nl : sp > start + max / 2 ? sp : -1
      if (cut > 0) end = cut + 1
    }
    out.push({ piece: cps.slice(start, end).join(''), start })
    if (end >= cps.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out
}

/** Doppelte Treffer aus überlappenden Stücken entfernen. */
export function dedupe(entities: readonly Entity[]): Entity[] {
  const seen = new Set<string>()
  return entities.filter((e) => {
    const k = `${e.start}:${e.end}:${e.entity_type}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ── Kodierungen ─────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BACKSLASH = String.fromCharCode(92)
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** base64 ohne Auffüllzeichen. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += B64[c & 63]
  }
  return out
}

/**
 * Die base64-Stücke eines Werts, der irgendwo in einem längeren base64-Text steht: je nach Lage
 * im Byte-Strom (Versatz 0, 1 oder 2) sieht er anders aus. Zeichen, in die Nachbarbytes
 * hineinreichen, werden abgeschnitten.
 */
function base64Fragments(bytes: Uint8Array): string[] {
  const out: string[] = []
  for (const k of [0, 1, 2]) {
    const buf = new Uint8Array(k + bytes.length)
    buf.set(bytes, k)
    let s = toBase64(buf).slice([0, 2, 3][k])
    if ((k + bytes.length) % 3 !== 0) s = s.slice(0, -1)
    out.push(s)
  }
  return out
}

/** Kodierte Formen unter dieser Länge gibt es nicht (ein Wert hat mindestens 3 Zeichen). */
const ENCODED_MIN = 4
/** Kodierte Formen unter dieser Länge zählen nur am Rand eines Laufs: mitten in einer Ziffernfolge träfen sie zufällig. */
const ENCODED_ANYWHERE = 16
const RUN_CHAR = /[A-Za-z0-9+/_-]/

/** Steht die kodierte Form `f` in `hay`? Kurze Formen nur am Anfang oder Ende eines Laufs. */
function encodedHit(hay: string, f: string): boolean {
  if (f.length >= ENCODED_ANYWHERE) return hay.includes(f)
  for (let i = hay.indexOf(f); i >= 0; i = hay.indexOf(f, i + 1)) {
    const before = i === 0 || !RUN_CHAR.test(hay[i - 1] ?? '')
    const after = i + f.length >= hay.length || !RUN_CHAR.test(hay[i + f.length] ?? '')
    // Hex besteht nur aus Ziffern und a–f: am Rand einer Zahl träfe es zufällig, also nur als ganzer Lauf.
    if (/^[0-9a-fA-F]+$/.test(f) ? before && after : before || after) return true
  }
  return false
}

type Forms = { text: string[]; encoded: string[] }
const formCache = new Map<string, Forms>()

function formsOf(value: string): Forms {
  const hit = formCache.get(value)
  if (hit) return hit
  const text = new Set<string>([value, JSON.stringify(value).slice(1, -1)])
  const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
  const esc = (c: number) => `${BACKSLASH}u${c.toString(16).padStart(4, '0')}`
  text.add(units.map(esc).join(''))
  text.add(units.map((c) => esc(c).toUpperCase().replace(`${BACKSLASH}U`, `${BACKSLASH}u`)).join(''))
  text.add(units.map((c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : esc(c))).join(''))
  const pct = encodeURIComponent(value)
  text.add(pct)
  text.add(pct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()))
  text.add(pct.replace(/%20/g, '+'))
  const bytes = utf8(value)
  const encoded = new Set<string>()
  for (const f of base64Fragments(bytes)) {
    encoded.add(f)
    encoded.add(f.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  encoded.add(hex(bytes))
  encoded.add(hex(bytes).toUpperCase())
  const forms = { text: [...text].filter((f) => f.length >= 3), encoded: [...encoded].filter((f) => f.length >= ENCODED_MIN) }
  if (formCache.size > 5000) formCache.clear()
  formCache.set(value, forms)
  return forms
}

/**
 * Alle Formen, in denen ein Wert in einem Text stehen kann: roh, JSON-maskiert, `\uXXXX`
 * (ganz und nur außerhalb von ASCII), Prozent-Kodierung, base64 und base64url mit drei Versätzen,
 * Hex klein und groß. Kodierte Formen unter 8 Zeichen fallen weg.
 */
export function leakForms(value: string): string[] {
  const f = formsOf(value)
  return [...f.text, ...f.encoded]
}

/** Zeilenumbrüche, roh und JSON-maskiert, die eine base64-Zeile teilen können. */
const BREAKS = new RegExp(`${BACKSLASH}${BACKSLASH}r${BACKSLASH}${BACKSLASH}n|${BACKSLASH}${BACKSLASH}[nr]|\\r?\\n`, 'g')

/** Wird der Wert ohne Rücksicht auf Groß- und Kleinschreibung gesucht? Starke Typen und mehrteilige Werte. */
function caseFree(value: string, token: string, isAlias: boolean): boolean {
  return !isAlias && (!WEAK_TYPES.has(typeOf(token)) || /\s/.test(value.trim()))
}

/**
 * Sucht bekannte Originalwerte in einem Text (Anfragekörper, URL, Argumente eines Werkzeugs) in
 * allen Formen aus `leakForms`, an Wortgrenzen für die Textformen. Starke Typen und mehrteilige
 * Werte auch in anderer Groß- und Kleinschreibung; für die kodierten Formen werden dazu klein- und
 * großgeschriebene Fassung kodiert, und Zeilenumbrüche werden vorher entfernt.
 * `strong` ist ein Leck, das die Anfrage stoppen soll: Werte eindeutiger Typen (E-Mail, IBAN,
 * Telefon, Nummern), mehrteilige Namen und deren Teile. Ein einzelnes Wort als Name oder Ort ist zu
 * mehrdeutig, um eine Sitzung anzuhalten; es wird nur gemeldet.
 */
export function findLeak(text: string, vault: Vault): { token: string; strong: boolean } | undefined {
  let weak: { token: string; strong: boolean } | undefined
  const lower = text.toLowerCase()
  let flat: string | undefined
  for (const { value, token, isAlias } of knownValues(vault)) {
    const ci = caseFree(value, token, isAlias)
    const variants = ci ? [...new Set([value, value.toLowerCase(), value.toUpperCase()])] : [value]
    let hit = false
    for (const variant of variants) {
      const { text: plain, encoded } = formsOf(variant)
      hit = plain.some((f) => (ci ? lower.includes(f.toLowerCase()) && wordRe(f, 'iu').test(text) : text.includes(f) && wordRe(f, 'u').test(text)))
      if (!hit) {
        flat ??= text.replace(BREAKS, '')
        const hay = flat
        hit = encoded.some((f) => encodedHit(hay, f))
      }
      if (hit) break
    }
    if (!hit) continue
    // Ein Namensteil allein stoppt keine Anfrage: „Claude“ aus „Claude Monet“ stünde in jedem
    // System-Prompt. Er wird gemeldet; der ganze Name und eindeutige Typen stoppen.
    const strong = !isAlias && (!WEAK_TYPES.has(typeOf(token)) || /\s/.test(value.trim()))
    if (strong) return { token, strong }
    weak ??= { token, strong }
  }
  return weak
}

// ── Ausgabeseite: kodierte Abschnitte ────────────────────────────────

/** Ersatztext für einen kodierten Abschnitt mit erkannten oder bekannten Daten. */
export const ENCODED_WITHHELD = msg('en', 'encodedWithheld')

/** Ein Abschnitt aus base64-, base64url- oder Hex-Zeichen; `start`/`end` in UTF-16-Einheiten. */
export type EncodedRun = { start: number; end: number; decoded: string | null }

const RUN_CHARS = /[A-Za-z0-9+/_-]+={0,2}/g
const B64_MIN = 16
const HEX_MIN = 32
const STRICT_MIN = 512

/**
 * Alle Läufe aus base64-Zeichen ab 8 Zeichen. Umgebrochene base64-Zeilen (eine volle Zeile ab 40
 * Zeichen, Länge durch 4 teilbar, ohne `=`, danach ein Zeilenumbruch) werden zusammengefügt.
 */
function rawRuns(text: string): Array<{ start: number; end: number }> {
  // Jeder Lauf merkt sich seine Zeilen: ein Zusammenfügen ist eine Vermutung und wird unten geprüft.
  const out: Array<{ start: number; end: number; lines: Array<{ start: number; end: number }> }> = []
  for (const m of text.matchAll(RUN_CHARS)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    const prev = out.at(-1)
    if (prev) {
      // Linear: nur die letzte Zeile des Laufs ansehen, nie den ganzen bisherigen Lauf kopieren.
      const last = prev.lines.at(-1) ?? prev
      const lineLen = last.end - last.start
      const gapLen = start - prev.end
      const gap = gapLen <= 2 ? text.slice(prev.end, start) : ''
      const atLineStart = prev.lines.length > 1 || prev.start === 0 || text[prev.start - 1] === '\n'
      if ((gap === '\n' || gap === '\r\n') && atLineStart && lineLen >= 40 && lineLen % 4 === 0 && text[last.end - 1] !== '=') {
        prev.end = end
        prev.lines.push({ start, end })
        continue
      }
    }
    out.push({ start, end, lines: [{ start, end }] })
  }
  // Live gefunden 2026-11-16: Auf eine einzeilige base64-Ausgabe folgte eine gewöhnliche Textzeile
  // („Shell cwd was reset …“). Ihr erstes Wort wurde angehängt, der Lauf ließ sich nicht mehr
  // dekodieren, und der Klartext ging kodiert durch. Darum: Lässt sich ein zusammengefügter Lauf
  // nicht dekodieren, werden hinten Zeilen abgelöst, bis der Rest lesbar ist; die abgelösten Zeilen
  // sind eigene Läufe. Höchstens zwei Zeilen: Mehr kostete bei einem großen Binärblock für jede
  // Zeile ein ganzes Dekodieren. Bleibt er unlesbar, gilt der ganze Lauf (umgebrochene Prüfsumme).
  const result: Array<{ start: number; end: number }> = []
  for (const r of out) {
    const n = r.lines.length
    let keep = n
    if (n > 1 && decodeRun(text.slice(r.start, r.end)) === null) {
      keep = n
      for (const tryKeep of [n - 1, n - 2]) {
        if (tryKeep >= 1 && decodeRun(text.slice(r.start, r.lines[tryKeep - 1]?.end)) !== null) {
          keep = tryKeep
          break
        }
      }
    }
    const whole = { start: r.start, end: r.lines[keep - 1]?.end ?? r.end }
    result.push(...realign(text, whole), ...r.lines.slice(keep))
  }
  return result.filter((r) => r.end - r.start >= 8)
}

/**
 * Ein Lauf, der sich nicht dekodieren lässt, kann vorn etwas Fremdes tragen: das `n` eines
 * JSON-maskierten Umbruchs (`\\nQW5u…`), ein `0x` vor Hex, oder ein URL-Pfad vor base64
 * (`org/reset/YW5u…`). Dann gelten die Teilstücke als eigene Läufe. Sparsam: nur diese drei Fälle.
 */
function realign(text: string, r: { start: number; end: number }): Array<{ start: number; end: number }> {
  if (r.end - r.start > 100_000 || decodeRun(text.slice(r.start, r.end)) !== null) return [r]
  let start = r.start
  if (text[start - 1] === '\\' && /[nrt]/.test(text[start] ?? '')) start++
  if (/^0x/i.test(text.slice(start, start + 2))) start += 2
  if (start !== r.start && decodeRun(text.slice(start, r.end)) !== null) return [{ start, end: r.end }]
  const s = text.slice(start, r.end)
  if (!s.includes('/')) return [r]
  const parts: Array<{ start: number; end: number }> = []
  let at = start
  for (const piece of s.split('/')) {
    parts.push({ start: at, end: at + piece.length })
    at += piece.length + 1
  }
  return parts.some((x) => decodeRun(text.slice(x.start, x.end)) !== null) ? parts : [r]
}

/** Der lesbare Klartext eines Laufs (Hex ab 32, base64 ab 16 Zeichen), sonst `null`. */
function decodeRun(s: string): string | null {
  const bare = s.replace(/[\r\n=]/g, '')
  if (/^[0-9a-fA-F]+$/.test(bare) && bare.length >= HEX_MIN) return decodeBytes(hexBytes(bare))
  if (bare.length < B64_MIN) return null
  const bytes = base64Bytes(bare)
  return bytes ? decodeBytes(bytes) : null
}

function base64Bytes(s: string): Uint8Array | null {
  let t = s.replace(/[\r\n=]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (t.length % 4 === 1) t = t.slice(0, -1)
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of t) {
    const v = B64.indexOf(ch)
    if (v < 0) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}

function hexBytes(s: string): Uint8Array {
  const t = s.length % 2 ? s.slice(0, -1) : s
  return Uint8Array.from({ length: t.length / 2 }, (_, i) => parseInt(t.slice(i * 2, i * 2 + 2), 16))
}

/** Strenges UTF-8: jede ungültige Folge ergibt `null`. */
function utf8Strict(b: Uint8Array): string | null {
  let out = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i] ?? 0
    let n = 0
    let cp = 0
    if (c < 0x80) [n, cp] = [0, c]
    else if (c >= 0xc2 && c <= 0xdf) [n, cp] = [1, c & 0x1f]
    else if (c >= 0xe0 && c <= 0xef) [n, cp] = [2, c & 0x0f]
    else if (c >= 0xf0 && c <= 0xf4) [n, cp] = [3, c & 0x07]
    else return null
    if (i + n >= b.length && n > 0) return null
    for (let k = 1; k <= n; k++) {
      const d = b[i + k] ?? 0
      if ((d & 0xc0) !== 0x80) return null
      cp = (cp << 6) | (d & 0x3f)
    }
    if ((n === 2 && cp < 0x800) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return null
    out += String.fromCodePoint(cp)
    i += n + 1
  }
  return out
}

const PRINTABLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]/u

/**
 * Lesbarer Text: mindestens 4 Zeichen, mehr als 95 % druckbar. Für UTF-16 zählen nur Zeichen bis
 * U+07FF (lateinische, griechische, kyrillische, arabische, hebräische Schrift) und allgemeine
 * Satzzeichen: Zufallsbytes ergeben als UTF-16 fast immer Zeichen aus großen Schriften (CJK) und
 * sähen sonst lesbar aus.
 */
function readable(s: string, narrow: boolean): boolean {
  const cps = Array.from(s.replace(/^\uFEFF/, ''))
  if (cps.length < 4) return false
  let ok = 0
  for (const ch of cps) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0xfffd) continue
    if (narrow && !(c <= 0x07ff || (c >= 0x2000 && c <= 0x20cf))) continue
    if (PRINTABLE.test(ch)) ok++
  }
  return ok / cps.length > 0.95
}

/** Dekodiert Bytes als UTF-8 oder UTF-16LE, wenn das lesbaren Text ergibt; sonst `null`. */
function decodeBytes(b: Uint8Array): string | null {
  const u8 = utf8Strict(b)
  if (u8 !== null && readable(u8, false)) return u8
  const n = b.length - (b.length % 2)
  let u16 = ''
  for (let i = 0; i < n; i += 2) u16 += String.fromCharCode((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8))
  if (n >= 8 && readable(u16, true)) return u16.replace(/^\uFEFF/, '')
  return null
}

/**
 * Kodierte Abschnitte eines Texts: base64 und base64url ab 16 Zeichen (umgebrochene Zeilen
 * zusammengefügt) und Hex ab 32 Zeichen. `decoded` ist der Klartext, wenn er lesbar ist (UTF-8 oder
 * UTF-16, mindestens 4 Zeichen, mehr als 95 % druckbar), sonst `null`: so bleiben Commit-Kennungen
 * und Prüfsummen ohne Anfrage stehen (gemessen 2026-11-16: `git log -30 --format='%H %T'`).
 */
export function encodedRuns(text: string): EncodedRun[] {
  const out: EncodedRun[] = []
  for (const r of rawRuns(text)) {
    const s = text.slice(r.start, r.end)
    const bare = s.replace(/[\r\n=]/g, '')
    if (/^[0-9a-fA-F]+$/.test(bare) && bare.length >= HEX_MIN) {
      out.push({ ...r, decoded: decodeBytes(hexBytes(bare)) })
    } else if (bare.length >= B64_MIN) {
      const bytes = base64Bytes(bare)
      out.push({ ...r, decoded: bytes ? decodeBytes(bytes) : null })
    }
  }
  return out
}

/** Ein Treffer der Erkennung, der selbst ein kodierter Abschnitt ist, ist kein Name. */
export function looksEncoded(t: string): boolean {
  const s = t.trim()
  return /^[A-Za-z0-9+/_=-]{16,}$/.test(s) && /[0-9+/=_]/.test(s)
}

/**
 * Was mit den kodierten Abschnitten eines Texts geschieht, bevor er an die Erkennung geht:
 * - `replace`: lokal ersetzen, ohne Anfrage. Darin steht ein bekannter Wert, kodiert (ohne
 *   Längenschwelle, über `leakForms` der bekannten Werte) oder im dekodierten Text; im Modus
 *   `strict` auch nicht dekodierbare Abschnitte ab 512 Zeichen, außer in Zeilen mit `integrity`
 *   oder `sha512-`.
 * - `ask`: dekodierbare Abschnitte ohne bekannten Wert; sie gehen zusammen in einer Anfrage an die
 *   Erkennung.
 * Nicht dekodierbare Abschnitte bleiben sonst stehen.
 */
export function encodedPlan(text: string, vault: Vault, mode: string): { replace: Array<{ start: number; end: number }>; ask: Array<{ start: number; end: number; decoded: string }> } {
  const replace: Array<{ start: number; end: number }> = []
  const ask: Array<{ start: number; end: number; decoded: string }> = []
  const runs = new Map(encodedRuns(text).map((x) => [x.start, x]))
  const values = knownValues(vault)
  const known = values.length > 0
  for (const r of rawRuns(text)) {
    const candidate = runs.get(r.start)
    const run = candidate && candidate.end === r.end ? candidate : undefined
    const s = text.slice(r.start, r.end)
    // Auf dem rohen Lauf nur die KODIERTEN Formen: Ein bekannter Wert im Klartext („Mustermann“,
    // eine IBAN) ist kein kodierter Abschnitt; ihn ersetzt `sweepKnown` durch seinen Platzhalter.
    if (known && (encodedLeak(s, values) || (run?.decoded && findLeak(run.decoded, vault)))) {
      replace.push(r)
    } else if (run?.decoded) {
      ask.push({ start: r.start, end: r.end, decoded: run.decoded })
    } else if (run && mode === 'strict' && r.end - r.start >= STRICT_MIN) {
      const lineStart = text.lastIndexOf('\n', r.start) + 1
      const lineEnd = text.indexOf('\n', r.end)
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
      if (!/integrity|sha512-/.test(line)) replace.push(r)
    }
  }
  return { replace, ask }
}

/** Steht ein bekannter Wert in kodierter Form (base64, base64url, Hex) in diesem Lauf? */
function encodedLeak(run: string, values: ReadonlyArray<{ value: string; token: string; isAlias: boolean }>): boolean {
  const flat = run.replace(BREAKS, '')
  for (const { value, token, isAlias } of values) {
    const ci = caseFree(value, token, isAlias)
    const variants = ci ? [...new Set([value, value.toLowerCase(), value.toUpperCase()])] : [value]
    for (const variant of variants) {
      if (formsOf(variant).encoded.some((f) => encodedHit(flat, f))) return true
    }
  }
  return false
}

/** Trenner zwischen dekodierten Abschnitten in der einen Anfrage. */
export const RUN_SEPARATOR = '\n\n'

/** Welche der dekodierten Abschnitte einen Treffer haben; Offsets der Treffer in Codepunkten. */
export function runsWithHits(decoded: readonly string[], entities: readonly Entity[]): Set<number> {
  const starts: number[] = []
  let at = 0
  for (const d of decoded) {
    starts.push(at)
    at += Array.from(d).length + Array.from(RUN_SEPARATOR).length
  }
  const hit = new Set<number>()
  for (const e of entities) {
    if (typeof e.start !== 'number') continue
    for (let i = starts.length - 1; i >= 0; i--) {
      if (e.start >= (starts[i] ?? 0)) {
        hit.add(i)
        break
      }
    }
  }
  return hit
}

/** Ersetzt die genannten Abschnitte durch `marker`, von hinten nach vorn. */
export function replaceSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>, marker: string): string {
  let out = text
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + marker + out.slice(s.end)
  return out
}

// ── Befehle: ablehnen und nachfragen ─────────────────────────────────

/** Satz, den jede Ablehnung und jede Nachfrage des Mods trägt. */
export const NOT_A_LOCK = msg('en', 'notALock')

export type ShellVerdict = { action: 'deny' | 'ask'; reason: string }

/** Kommentare und Heredoc-Inhalte entfernen: beides sind keine Befehle. Ein Apostroph in einem Kommentar öffnet so kein Zitat. */
function stripNonCode(command: string): string {
  const kept: string[] = []
  let until: string | null = null
  for (const line of command.replace(/\r\n/g, '\n').split('\n')) {
    if (until !== null) {
      if (line.trim() === until) until = null
      continue
    }
    kept.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) until = m[2] ?? null
  }
  const t = kept.join('\n')
  let out = ''
  let q: string | null = null
  for (let i = 0; i < t.length; i++) {
    const c = t[i] ?? ''
    if (q !== null) {
      out += c
      if (c === '\\' && q === '"' && i + 1 < t.length) out += t[++i] ?? ''
      else if (c === q) q = null
    } else if (c === '\\' && i + 1 < t.length) {
      out += c + (t[++i] ?? '')
    } else if (c === '"' || c === "'") {
      q = c
      out += c
    } else if (c === '#' && (i === 0 || /\s/.test(t[i - 1] ?? ''))) {
      while (i < t.length && t[i] !== '\n') i++
      out += '\n'
    } else out += c
  }
  return out
}

/**
 * Inhalt in Anführungszeichen unkenntlich machen, gleiche Länge. Ein `$(…)` in "…" ist wieder
 * Befehlstext: sein Inhalt bleibt lesbar, damit ein Rohr darin gesehen wird.
 */
function maskQuotes(s: string): string {
  let out = ''
  const stack: Array<'sq' | 'dq' | 'sub'> = []
  const depth: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    const top = stack.at(-1)
    if (top === 'sq') {
      if (c === "'") stack.pop()
      out += c === "'" ? c : 'x'
    } else if (top === 'dq') {
      if (c === '\\' && i + 1 < s.length) {
        out += 'xx'
        i++
      } else if (c === '"') {
        stack.pop()
        out += c
      } else if (c === '$' && s[i + 1] === '(') {
        stack.push('sub')
        depth.push(0)
        out += '$('
        i++
      } else out += c === '`' || c === '$' ? c : 'x'
    } else if (c === "'" || c === '"') {
      stack.push(c === "'" ? 'sq' : 'dq')
      out += c
    } else if (c === '\\' && i + 1 < s.length) {
      // `\base64` ist `base64`; sonst (`\;`, `\ `) bleibt die Stelle unkenntlich.
      const n = s[i + 1] ?? ''
      out += /[A-Za-z0-9]/.test(n) ? ` ${n}` : 'xx'
      i++
    } else if (top === 'sub' && c === '(') {
      depth[depth.length - 1] = (depth.at(-1) ?? 0) + 1
      out += c
    } else if (top === 'sub' && c === ')') {
      if ((depth.at(-1) ?? 0) === 0) {
        stack.pop()
        depth.pop()
      } else depth[depth.length - 1] = (depth.at(-1) ?? 1) - 1
      out += c
    } else out += c
  }
  return out
}

function wordsOf(raw: string): string[] {
  return (raw.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []).map((w) => w.replace(/^'(.*)'$|^"(.*)"$/s, '$1$2').replace(/(["'])/g, ''))
}

/** Programme, die ein anderes Programm starten; ihre Optionen werden übersprungen. */
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'nice', 'ionice', 'exec', 'command', 'builtin', 'xargs', 'stdbuf', 'timeout', 'watch', 'busybox', 'setsid', '.'])
/** Schlüsselwörter der Shell vor einem Befehl. */
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time'])
/** Optionen von Wrappern, die einen eigenen Wert haben (`sudo -u root`, `timeout -s KILL`, `xargs -I {}`). */
const VALUE_OPTS = new Set(['-u', '-g', '-s', '-k', '-n', '-I', '-P', '-L', '-E', '-h', '-C', '-p'])
const base = (w: string) => w.replace(/^\\+/, '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')
const isRedirect = (w: string) => /^\d*(<<<|<<|<|>>|>|&>)/.test(w)
const bareRedirect = (w: string) => /^\d*(<<<|<<|<|>>|>|&>)$/.test(w)

/** Umleitungen und ihre Ziele aus einer Wortliste nehmen. */
function withoutRedirects(words: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? ''
    if (isRedirect(w)) {
      if (bareRedirect(w)) i++
      continue
    }
    out.push(w)
  }
  return out
}

function commandName(all: string[]): { name: string; args: string[] } {
  const words = withoutRedirects(all)
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {
      i++
      continue
    }
    if (WRAPPERS.has(base(w))) {
      const wrapper = base(w)
      i++
      // `command -v xxd` fragt nur, ob es das Programm gibt.
      if (wrapper === 'command' && /^-[vV]$/.test(words[i] ?? '')) return { name: '', args: [] }
      while (i < words.length) {
        const o = words[i] ?? ''
        if (o.startsWith('-')) {
          i += VALUE_OPTS.has(o) ? 2 : 1
        } else if (/^\d+(\.\d+)?[smhd]?$/.test(o) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(o)) i++
        else break
      }
      continue
    }
    break
  }
  // `base64<datei`: der Name endet vor der Umleitung.
  const first = (words[i] ?? '').replace(/[<>].*$/, '')
  return { name: base(first), args: words.slice(i + 1) }
}

/** Ein `echo`/`printf` mit festem Text: kein `$(…)`, kein Backtick, kein `$VAR`, kein `<`. */
function fixedEcho(raw: string): boolean {
  return /^\s*(echo|printf)(\s|$)/i.test(raw) && !/[$`<]/.test(raw)
}

const REMOTE = /^(?:[\w.-]+@)?[\w.-]{2,}:|^rsync:\/\//
const isRemote = (a: string) => !a.startsWith('-') && REMOTE.test(a) && !/^[a-zA-Z]:[\\/]/.test(a)

/** Anweisungen trennen sich an Zeilenende, `;`, `&&`, `||` und `&`. */
const STATEMENT = /\n|;|&&|\|\||(?<![<>|])&(?![>&])/g
/** Innerhalb einer Anweisung beginnt hier ein neuer Befehl. Die Rohr-Zeichen stehen zuerst. */
const PIECE = /\|&|\||\$\(|<\(|>\(|[(){}`]/g

type Where = { piped: boolean; pipeAfter: boolean; producer: string; redirectIn: boolean; masked: string }

/**
 * Wie der Mod einen Shell-Befehl einstuft (`Bash`, `PowerShell`, `Monitor`). Eine Klassifikation
 * für Ablehnung und Nachfrage, damit sich beide nicht widersprechen. Abgelehnt wird, was die
 * Ausgabeseite nicht lesen kann (Hex- und Oktal-Dumps, Packer auf die Standardausgabe), `base64`
 * mit einer Datei, einer Umleitung oder einem Rohr als Eingabe, und Datei-Versand per HTTP oder
 * Netcat. Nachgefragt wird bei `scp`, `sftp`, `rsync` zu einem Host und `tar c … |`. Das ist eine
 * Liste gängiger Befehle, keine Sperre: eigene Skripte und andere Wege gehen durch.
 */
export function shellVerdict(input: string, lang: Lang = 'en'): ShellVerdict | undefined {
  const deny = (reason: string): ShellVerdict => ({ action: 'deny', reason })
  const command = stripNonCode(input)
  const masked = maskQuotes(command)
  if (/\[(system\.)?convert\]::to(base64|hex)string/i.test(command)) return deny('[Convert]::ToBase64String / ToHexString')
  if (/\[(system\.)?io\.file\]::readallbytes/i.test(command)) return deny('[IO.File]::ReadAllBytes')
  if (/(^|\s)-AsB[a-z]*\b/i.test(masked)) return deny('-AsByteStream')
  if (/(^|\s)-Encoding[:\s]+['"]?Byte\b/i.test(command)) return deny('-Encoding Byte')
  let ask: ShellVerdict | undefined
  let at = 0
  const statements: Array<{ start: number; end: number }> = []
  for (const m of masked.matchAll(STATEMENT)) {
    statements.push({ start: at, end: m.index ?? 0 })
    at = (m.index ?? 0) + m[0].length
  }
  statements.push({ start: at, end: masked.length })
  for (const st of statements) {
    const text = masked.slice(st.start, st.end)
    // Eine Umleitung aus einer Datei irgendwo in der Anweisung: `(base64) < datei`, `<datei base64`.
    const redirectIn = /(^|[^<])<(?![<(])\s*\S/.test(text)
    const pieces: Array<{ start: number; end: number; sep: string }> = []
    let p = 0
    let sep = ''
    for (const m of text.matchAll(PIECE)) {
      pieces.push({ start: st.start + p, end: st.start + (m.index ?? 0), sep })
      p = (m.index ?? 0) + m[0].length
      sep = m[0]
    }
    pieces.push({ start: st.start + p, end: st.end, sep })
    let piped = false
    let producer = ''
    let previous = ''
    for (const [k, piece] of pieces.entries()) {
      const raw = command.slice(piece.start, piece.end)
      if (piece.sep === '|' || piece.sep === '|&' || piece.sep === '>(') {
        piped = true
        producer = previous
      }
      if (raw.trim()) previous = raw
      const words = wordsOf(raw)
      const head = commandName(words)
      if (!head.name) continue
      const pipeAfter = pieces.slice(k + 1).some((x) => x.sep === '|' || x.sep === '|&')
      const where: Where = { piped, pipeAfter, producer, redirectIn, masked: masked.slice(piece.start, piece.end) }
      let v = judge(head.name, head.args, where, lang)
      if (!v && head.name === 'find') {
        // `find … -exec programm {} \;` startet das Programm mit Dateien als Eingabe.
        const i = head.args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a))
        if (i >= 0) {
          const inner = commandName(head.args.slice(i + 1))
          if (inner.name) v = judge(inner.name, inner.args, { ...where, piped: true, producer: 'find' }, lang)
        }
      }
      if (v?.action === 'deny') return v
      ask ??= v
    }
  }
  return ask
}

function judge(name: string, args: string[], where: Where, lang: Lang): ShellVerdict | undefined {
  const deny = (reason: string): ShellVerdict => ({ action: 'deny', reason })
  const flag = (re: RegExp) => args.some((a) => re.test(a))
  if (['base64', 'base32', 'basenc'].includes(name)) {
    if (flag(/^(-d|-D|--decode|-[a-ce-zA-Z]*d[a-zA-Z]*)$/)) return undefined
    const files: string[] = []
    for (let j = 0; j < args.length; j++) {
      const a = args[j] ?? ''
      if (a === '-w' || a === '--wrap') j++
      else if (a !== '-' && !a.startsWith('-')) files.push(a)
    }
    if (where.redirectIn) return deny(msg(lang, 'shellFileRedirect', { name }))
    if (files.length) return deny(msg(lang, 'shellFileInput', { name }))
    if (where.piped && !fixedEcho(where.producer)) return deny(msg(lang, 'shellPipeInput', { name }))
    return undefined
  }
  if (['xxd', 'od', 'hexdump', 'hd', 'rev', 'format-hex', 'fhx'].includes(name)) return deny(name)
  if (name === 'openssl' && ['enc', 'base64'].includes((args[0] ?? '').toLowerCase())) return deny(`openssl ${args[0]}`)
  if (name === 'certutil' && flag(/^[-/]encode(hex)?$/i)) return deny('certutil -encode')
  if (name === 'rg' && flag(/^--pre(=|$)/)) return deny('rg --pre')
  if (['gzip', 'bzip2', 'xz', 'zstd'].includes(name)) {
    const stdout = flag(/^(--stdout|-[a-zA-Z0-9]*c[a-zA-Z0-9]*)$/)
    const decompress = flag(/^(--decompress|-[a-zA-Z0-9]*d[a-zA-Z0-9]*)$/)
    // In eine Datei umgeleitet geht nichts ans Modell.
    const toFile = /(^|[^>])>{1,2}(?![(&])/.test(where.masked) && !where.pipeAfter
    if (stdout && !decompress && !toFile) return deny(`${name} -c`)
    return undefined
  }
  if (name === 'curl') {
    if (flag(/^@|=@|^-[a-zA-Z]*[dF]@|^-[a-zA-Z]*T$|^--upload-file/)) return deny(msg(lang, 'shellCurlFile'))
    return undefined
  }
  if (name === 'wget') {
    if (flag(/^--(post|body)-file/)) return deny(msg(lang, 'shellWgetFile'))
    return undefined
  }
  if (['nc', 'ncat', 'netcat'].includes(name)) return deny(name)
  if (['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm'].includes(name) && flag(/^-InFile$/i)) return deny(`${name} -InFile`)
  if (name === 'sftp') return { action: 'ask', reason: 'sftp' }
  if ((name === 'scp' || name === 'rsync') && args.some(isRemote)) return { action: 'ask', reason: msg(lang, 'shellRemote', { name }) }
  if (name === 'tar' && where.pipeAfter && (/^[^-]*c/.test(args[0] ?? '') || flag(/^(--create|-[a-zA-Z]*c[a-zA-Z]*)$/))) return { action: 'ask', reason: 'tar c … |' }
  return undefined
}

// ── Eigene Grenze ────────────────────────────────────────────────────

/**
 * Gleitendes Fenster der eigenen Anfragen: `times` sind die Zeitpunkte im Fenster. Ist die Grenze
 * erreicht, nennt `waitMs`, wann die älteste Anfrage aus dem Fenster fällt, und die neue Anfrage
 * wird nicht gezählt.
 */
export function rateWindow(times: readonly number[], now: number, limit: number, windowMs: number): { times: number[]; waitMs?: number } {
  const kept = times.filter((t) => now - t < windowMs)
  if (kept.length >= limit) return { times: kept, waitMs: windowMs - (now - (kept[0] ?? now)) }
  return { times: [...kept, now] }
}

/**
 * Warum `api_url` nicht benutzt wird, oder `undefined`: nur `https:`, und ein anderer
 * Host als anonym.legal nur mit `allow_other_host`.
 */
export function apiUrlProblem(url: string, allowOtherHost: boolean, lang: Lang = 'en'): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return msg(lang, 'urlInvalid', { url })
  }
  if (u.protocol !== 'https:') return msg(lang, 'urlHttps', { protocol: u.protocol })
  if (u.hostname !== 'anonym.legal' && !allowOtherHost) return msg(lang, 'urlHost', { host: u.hostname })
  return undefined
}

/** Der Text eines Anfragekörpers, auch wenn er als base64 kommt; `undefined`, wenn er nicht lesbar ist. */
export function bodyText(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object' && 'base64' in body && typeof (body as { base64: unknown }).base64 === 'string') {
    try {
      const bin = atob((body as { base64: string }).base64)
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Die Entscheidung des `http.fetch`-Hooks über eine Anfrage der Engine: URL und Körper werden
 * zusammen geprüft, eine Anfrage ohne Körper über die URL allein. Ein Körper, der
 * nicht lesbar ist, ergibt `unreadable`.
 */
export function requestLeak(url: string, body: unknown, vault: Vault): { unreadable: true } | { token: string; strong: boolean } | undefined {
  const text = bodyText(body)
  if (text === undefined && body !== undefined) return { unreadable: true }
  return findLeak(text === undefined ? url : `${url}
${text}`, vault)
}

/**
 * Welche Zeilen geprüft werden. Seit v0.3 alles, was das Modell liest, auch Zeilen anderer Mods
 * (Tür `note`), außer den Arten von Anhängen, die `skipAttachments` nennt. Eine Positivliste würde
 * fremde Inhalte übersehen.
 */
export function rowIsScanned(
  door: string,
  name: string | undefined,
  origin: string | undefined,
  opts: { scanHookContext: boolean; skipAttachments: ReadonlySet<string> },
): boolean {
  if (door === 'notice') return false
  if (door === 'hook-context' || origin === 'hook') return opts.scanHookContext
  if (door === 'attachment' && origin === 'engine' && name && opts.skipAttachments.has(name)) return false
  return true
}

/** Ob ein Text überhaupt geprüft werden muss: leere und zeichenlose Texte nicht. */
export function worthScanning(text: string): boolean {
  return /[\p{L}\p{N}@]/u.test(text) && text.trim().length >= 3
}

/** Häufige Befehlswörter am Satzanfang, die die Erkennung im Live-Test als PERSON meldete. */
const NOT_NAMES = new Set(['Lies', 'Nenne', 'Schreibe', 'Fasse', 'Zeige', 'Prüfe', 'Erstelle', 'Bitte', 'Danke', 'Hallo', 'Read', 'Use', 'Below', 'Note', 'Call', 'Run'])

/** Eine Versionsangabe wie in package.json und Lockfiles. */
const VERSION_LIKE = /^[\^~<>=v]*\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$/
/** Typen, deren Text wie eine Versionsangabe aussehen darf (Nummern, Daten). Alles andere ist dann ein Scheintreffer. */
const STRONG_VERSION_TYPES = new Set(['PHONE_NUMBER', 'DATE_TIME', 'IP_ADDRESS'])

/**
 * Treffer, die mit großer Wahrscheinlichkeit keine Personendaten sind. Gemessen im Live-Test und
 * in der Auswertung 2026-11-16: „Lies kunden.txt“ als PERSON, `xr-x` als Kennzeichen, Dateinamen
 * als URL, Zeitstempel als DATE_TIME. Für Namen, Orte und Organisationen gilt: kein Code-Zeichen,
 * kein kleingeschriebener Dateiname und, nur in Schriften mit Groß- und Kleinschreibung, ein
 * Großbuchstabe am Wortanfang. Andere Typen (E-Mail, IBAN, Telefon, Nummern) bleiben unberührt.
 */
export function plausible(e: Entity, minScore: number, ignore: ReadonlySet<string>, allow: ReadonlySet<string> = new Set()): boolean {
  const type = normalizeType(e.entity_type)
  if (ignore.has(type)) return false
  if (e.score < minScore) return false
  const t = (e.text ?? '').trim()
  if (allow.has(t.toLowerCase())) return false
  // eine Versionsangabe (`^1.1.4`, `16.1.1`, `~2.0.0-beta.3`) ist weder Name noch Ort noch Kennzeichen.
  if (VERSION_LIKE.test(t) && !STRONG_VERSION_TYPES.has(type)) return false
  if (['PERSON', 'LOCATION', 'ORGANIZATION', 'NRP'].includes(type)) {
    if (Array.from(t).length < 2) return false
    if (/[\\/<>{}=`|#$]|::|\(\)/.test(t)) return false
    if (/(^|\s)[\p{Ll}\d_-]+\.\w{1,5}\b/u.test(t)) return false
    const cased = /[\p{Lu}\p{Ll}]/u.test(t)
    if (cased && !/(^|[\s_])\p{Lu}/u.test(t)) return false
    if (type === 'PERSON' && NOT_NAMES.has(t)) return false
  }
  if (type === 'DE_LICENSE_PLATE' && /^[-rwxdsStT]+$/.test(t.replace(/\s/g, ''))) return false
  return true
}

/** Ein Namens-Treffer der Erkennung, der selbst ein kodierter Abschnitt ist (live gemessen 2026-11-16). */
export function encodedNameHit(e: Entity): boolean {
  return ['PERSON', 'LOCATION', 'ORGANIZATION', 'NRP'].includes(normalizeType(e.entity_type)) && looksEncoded(e.text ?? '')
}

function normalizeType(type: string): string {
  return type.toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'PII'
}

/**
 * Eine Anfrage an `/v1/messages/count_tokens`. Claude Code zählt damit große Werkzeug-Ergebnisse,
 * BEVOR der Mod sie schwärzt; der Körper trägt den Klartext, auch Werte, die der Mod noch nicht kennt
 * (live gemessen 2026-11-17: Name, E-Mail und Telefon aus einer 107-kB-Datei). Solche Anfragen
 * lässt der Mod nicht hinaus.
 */
export function isTokenCountRequest(url: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return false
  }
  return /\/v1\/messages\/count_tokens\/?$/.test(path)
}

