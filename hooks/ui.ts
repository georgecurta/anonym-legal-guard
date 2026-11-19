// Firewall-Seitenleiste und Sperr-Band (0.8): nur reine Funktionen „Zustand → Texte“.
// Kein `$`, kein Netz. Was hier hineingeht und herauskommt, ist wertfrei: Zustände, Gründe, Typen,
// Zähler, Zeiten, Oberflächennamen. Nie ein Klarwert, nie ein Platzhalter, nie der Token: Pane und Band
// zeichnen auf jeder angehängten Oberfläche (auch auf denen, die Platzhalter zeigen).

import type { DerivedStatus, GuardState } from './core'
import { msg, type Lang } from './messages'

/** Die Kennung der Pane (`$.ui.open`, `ui.render` mit `requestId`). */
export const PANE_ID = 'anonym-legal-firewall'
export const PANE_TITLE = 'anonym.legal Firewall'

// ── Nur feste Listen anzeigen ──────────────────────────
// Typnamen, Sprachcodes und Oberflächennamen kommen vom Server bzw. der Engine. Ein bösartiger oder
// fehlerhafter Server könnte als `entity_type` einen Klarwert schicken („Anna Berg“ → „ANNA_BERG“).
// Angezeigt wird darum nur, was in einer festen Liste steht; alles andere wird zu „Andere“ gezählt.

/** Typen, die der Mod und der Analyzer (Presidio und anonym.legal) kennen. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'PII', 'PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'IBAN_CODE', 'CREDIT_CARD', 'CRYPTO', 'IP_ADDRESS', 'MAC_ADDRESS',
  'LOCATION', 'ADDRESS', 'DATE_TIME', 'NRP', 'URL', 'ORGANIZATION', 'MEDICAL_LICENSE', 'PASSPORT', 'MRZ', 'ID',
  'US_SSN', 'US_PASSPORT', 'US_DRIVER_LICENSE', 'US_BANK_NUMBER', 'US_ITIN', 'UK_NHS', 'UK_NINO', 'UK_PASSPORT',
  'DE_TAX_ID', 'DE_ID_CARD', 'DE_PASSPORT', 'DE_SOCIAL_SECURITY', 'DE_LICENSE_PLATE', 'ES_NIF', 'ES_NIE', 'IT_FISCAL_CODE',
  'IT_DRIVER_LICENSE', 'IT_VAT_CODE', 'IT_PASSPORT', 'IT_IDENTITY_CARD', 'PL_PESEL', 'FI_PERSONAL_IDENTITY_CODE',
  'SG_NRIC_FIN', 'SG_UEN', 'AU_ABN', 'AU_ACN', 'AU_TFN', 'AU_MEDICARE', 'IN_PAN', 'IN_AADHAAR', 'IN_VEHICLE_REGISTRATION',
  'IN_VOTER', 'IN_PASSPORT', 'KR_RRN', 'TH_TNIN', 'BIC_CODE', 'SWIFT_CODE', 'VAT_ID', 'TAX_ID', 'NATIONAL_ID',
  'LICENSE_PLATE', 'BANK_ACCOUNT', 'AGE', 'GENDER',
])

/** Die Oberflächen, die Claude Code 2.1.326 kennt. */
export const KNOWN_SURFACES: ReadonlySet<string> = new Set(['terminal', 'desktop', 'vscode', 'mobile'])

/**
 * Sprachcodes, die angezeigt werden: die 48 Sprachen der Website und die Liste der unterstützten Sprachen, dazu `account`. Alles andere wird „andere“.
 */
export const KNOWN_LANGUAGES: ReadonlySet<string> = new Set([
  'en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ko', 'ro', 'el', 'hr', 'sl', 'mk', 'sv', 'da', 'nb',
  'fi', 'uk', 'lt', 'ca', 'tr', 'bg', 'hu', 'he', 'vi', 'af', 'hy', 'eu', 'ar', 'hi', 'cs', 'sk', 'id', 'th', 'fa', 'sr',
  'lv', 'et', 'ms', 'bn', 'ur', 'sw', 'tl', 'is',
  'no', 'sq', 'be', 'ka', 'az', 'kk', 'uz', 'tg', 'mn',
  'account',
])

/** Ein Sprachcode zum Anzeigen: aus der festen Liste, sonst „andere“ (auch für Codes aus der Konfiguration). */
export const shownLanguage = (code: unknown, lang: Lang): string => knownLanguage(code) ?? msg(lang, 'langOther')

/** Voreinstellungen von anonym.legal, die beim Namen angezeigt werden (README, Desktop-Fallback-Presets). */
export const KNOWN_PRESETS: ReadonlySet<string> = new Set(['developer', 'dev', 'general', 'gdpr', 'hipaa', 'financial'])

/** Die Werte der Schalter, wie `plugin.json` sie anbietet; ein anderer Wert wird „unbekannt“. */
export const SWITCH_VALUES = {
  shell_guard: ['block', 'ask', 'off'],
  encoded_runs: ['scan', 'strict', 'off'],
  leak_guard: ['log', 'block', 'off'],
  file_values: ['real', 'deny'],
} as const

/** Ein Schalterwert zum Anzeigen: aus der festen Liste, sonst „unbekannt“. */
export const shownSwitch = (name: keyof typeof SWITCH_VALUES, value: string, lang: Lang): string =>
  (SWITCH_VALUES[name] as readonly string[]).includes(value) ? value : msg(lang, 'unknown')

/** Ein Preset zum Anzeigen: bekannt beim Namen, sonst „eigenes“. */
export const shownPreset = (preset: string, lang: Lang): string =>
  KNOWN_PRESETS.has(preset.trim().toLowerCase()) ? preset.trim().toLowerCase() : msg(lang, 'presetOwn')

/** Die API-Adresse zum Anzeigen: „anonym.legal“ oder „eigener Host“, nie die URL. */
export function shownHost(apiUrl: string, lang: Lang): string {
  try {
    if (new URL(apiUrl).hostname === 'anonym.legal') return 'anonym.legal'
  } catch {
    // keine gültige Adresse
  }
  return msg(lang, 'hostOwn')
}

/** Ein Sprachcode aus der festen Liste (Groß/Klein egal), sonst `undefined`. */
export const knownLanguage = (code: unknown): string | undefined => {
  const c = String(code ?? '').trim().toLowerCase()
  return KNOWN_LANGUAGES.has(c) ? c : undefined
}

/** Ein Platzhalter für Anzeigen: mit bekanntem Typ unverändert, sonst nur „‹Andere›“ (der Typ kommt vom Server). */
export function shownToken(token: string, lang: Lang): string {
  const type = token.replace(/^‹/, '').replace(/_\d+·[a-z0-9]{3}›$/, '')
  return KNOWN_TYPES.has(type) && /^‹[A-Z0-9_]+_\d+·[a-z0-9]{3}›$/.test(token) ? token : `‹${msg(lang, 'typeOther')}›`
}

/** Zähler je Typ, nur bekannte Typen beim Namen; der Rest summiert als „Andere“. */
export function shownTypes(counter: Readonly<Record<string, number>>, lang: Lang): string {
  const out: string[] = []
  let other = 0
  for (const [k, n] of Object.entries(counter)) {
    const count = Number.isFinite(n) ? Number(n) : 0
    if (KNOWN_TYPES.has(k)) out.push(`${k} ${count}`)
    else other += count
  }
  if (other) out.push(`${msg(lang, 'typeOther')} ${other}`)
  return out.join(', ') || msg(lang, 'typesNone')
}

/** Ein Oberflächenname, nur aus der festen Liste; sonst „unbekannte Oberfläche“. */
export const shownSurface = (name: string, lang: Lang): string => (KNOWN_SURFACES.has(name) ? name : msg(lang, 'surfaceUnknown'))

/** Sprachcodes vom Server, nur echte Codes; alles andere einmal als „andere“. */
export function shownLanguages(codes: readonly string[], lang: Lang): string[] {
  const out: string[] = []
  let other = false
  for (const c of codes) {
    const known = knownLanguage(c)
    if (known) out.push(known)
    else other = true
  }
  if (other) out.push(msg(lang, 'langOther'))
  return [...new Set(out)]
}

const SYMBOL: Record<GuardState, string> = { protected: '🛡', checking: '⏳', failing: '⚠', unset: '○' }

export type PaneInput = {
  lang: Lang
  status: DerivedStatus
  /** Die letzte Prüfung DIESER Ladung; fehlt: noch keine. */
  check?: { status: number | 'net' | 'timeout'; at: number }
  /** Die Zeile zu den Erkennungssprachen, wie /pii sie nennt. */
  languages: string
  replaced: number
  /** Je Typ die Zahl der verschiedenen Werte (`vault.counter`): nur Typnamen und Zahlen. */
  counter: Readonly<Record<string, number>>
  blocked: number
  leaks: number
  withheld: number
  inWindow: number
  limit: number
  /** Die angehängten Oberflächen und ob sie Platzhalter zeigen. */
  surfaces: ReadonlyArray<{ name: string; placeholders: boolean }>
}

export type PaneModel = {
  title: string
  lines: string[]
  /** Die Fußzeile: eine Taste (Button mit `hotkey`) zum neu Prüfen, dazu Esc. */
  footer: { focus: string; hotkey: 'r'; label: string; close: string }
}

/** Uhrzeit in UTC, HH:MM:SS; unabhängig von der Zeitzone der Maschine. */
const clockTime = (at: number) => new Date(at).toISOString().slice(11, 19)

/** Kopfzeile: Symbol, Zustand, bei einem Grund dieser und der nächste Schritt (Texte der Statuszeile/Meldungen). */
export function stateLine(status: DerivedStatus, lang: Lang): string {
  const state = msg(lang, `state_${status.state}`)
  const detail = status.reason
    ? msg(lang, 'piiStateDetail', { reason: msg(lang, `reason_${status.reason}`), next: msg(lang, `next_${status.reason}`) })
    : ''
  return `${SYMBOL[status.state]} ${msg(lang, 'piiState', { state, detail })}`
}

export function paneModel(input: PaneInput): PaneModel {
  const { lang } = input
  const t = (key: Parameters<typeof msg>[1], params?: Record<string, string | number>) => msg(lang, key, params)
  const lines = [
    t('limits'),
    stateLine(input.status, lang),
    input.check ? t('paneLastCheck', { time: clockTime(input.check.at), code: String(input.check.status) }) : t('paneNoCheck'),
    input.languages,
    t('paneSession', { replaced: input.replaced }),
    t('paneTypes', { types: shownTypes(input.counter, lang) }),
    t('paneBlocked', { blocked: input.blocked, leaks: input.leaks, withheld: input.withheld }),
    t('paneWindow', { n: input.inWindow, limit: input.limit }),
  ]
  if (input.surfaces.length) {
    const each = input.surfaces.map((s) => t(s.placeholders ? 'surfacePlaceholder' : 'surfaceReal', { surface: shownSurface(s.name, lang) }))
    lines.push(t('piiSurfaces', { list: each.join(' · ') }))
  }
  return { title: PANE_TITLE, lines, footer: { focus: t('paneFocus'), hotkey: 'r', label: t('paneRecheck'), close: t('paneClose') } }
}

/** Die Zeile des Bands: nur bei `failing` und `unset`, Grund und nächster Schritt; sonst nichts. */
export function bandText(status: DerivedStatus, lang: Lang): string | undefined {
  if (status.state !== 'failing' && status.state !== 'unset') return undefined
  const reason = status.reason ?? (status.state === 'unset' ? 'no_key' : 'server')
  return msg(lang, 'bandLine', { reason: msg(lang, `reason_${reason}`), next: msg(lang, `next_${reason}`) })
}

/** Ob sich das Band ändert: derselbe Schlüssel heißt dieselbe Zeile. */
export const bandKey = (status: DerivedStatus) => (bandText(status, 'en') === undefined ? '' : `${status.state}:${status.reason ?? ''}`)
