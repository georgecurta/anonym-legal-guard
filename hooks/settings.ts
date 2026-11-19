// /pii-settings (0.7.2): alle Optionen mit aktuellem Wert, Standard und Erklärung, dazu fertige Profile.
// Grund (Eigentümer 2026-11-18): Claude Code zeigt im Dialog jede Option als „not set“ und nennt den
// Standard nicht; ein Mod kann diesen Dialog nicht ersetzen. Reine Funktion, ohne Netz testbar.

import type { Lang } from './messages'

type Setting = { key: string; def: string; group: 'daily' | 'guard' | 'tuning'; en: string; de: string }

export const SETTINGS: readonly Setting[] = [
  { key: 'api_key', def: '', group: 'daily', en: 'your anonym.legal API token (required)', de: 'dein API-Token von anonym.legal (Pflicht)' },
  { key: 'ui_language', def: 'en', group: 'daily', en: 'language of messages: en or de', de: 'Sprache der Meldungen: en oder de' },
  { key: 'language', def: 'account', group: 'daily', en: 'detection languages: account or up to three codes (de,en)', de: 'Erkennungssprachen: account oder bis zu drei Codes (de,en)' },
  { key: 'file_values', def: 'real', group: 'daily', en: 'real: files get real values; deny: strict mode', de: 'real: Dateien bekommen echte Werte; deny: Streng-Modus' },
  { key: 'media', def: 'drop', group: 'daily', en: 'drop: images/documents withheld; keep: sent unchecked', de: 'drop: Bilder/Dokumente zurückgehalten; keep: ungeprüft gesendet' },
  { key: 'leak_guard', def: 'block', group: 'guard', en: 'block: known values in a request are replaced, else the request stops; log; off', de: 'block: bekannte Werte in einer Anfrage werden ersetzt, sonst Stopp; log; off' },
  { key: 'shell_guard', def: 'block', group: 'guard', en: 'block: encoders/uploads refused, scp/rsync ask; ask; off', de: 'block: Kodierer/Uploads abgelehnt, scp/rsync fragen; ask; off' },
  { key: 'encoded_runs', def: 'scan', group: 'guard', en: 'scan: decodable base64/hex checked; strict; off', de: 'scan: dekodierbares base64/hex geprüft; strict; off' },
  { key: 'detokenize_bash', def: 'false', group: 'guard', en: 'true: shell commands get real values (can reach the network)', de: 'true: Shell-Befehle bekommen echte Werte (können ins Netz)' },
  { key: 'scan_hook_context', def: 'true', group: 'guard', en: 'also check output of hooks from your settings', de: 'auch Ausgaben der Hooks aus deinen Einstellungen prüfen' },
  { key: 'min_score', def: '0.5', group: 'tuning', en: 'matches below this score (0–1) are not replaced', de: 'Treffer unter diesem Wert (0–1) werden nicht ersetzt' },
  { key: 'ignore_types', def: 'URL,DATE_TIME,NRP,ORGANIZATION', group: 'tuning', en: 'entity types never replaced (list: anonym.legal/entities)', de: 'Typen, die nie ersetzt werden (Liste: anonym.legal/entities)' },
  { key: 'allow_values', def: 'Claude,Claude Code,…,Anthropic', group: 'tuning', en: 'values never replaced, case-insensitive, also when only a part is detected', de: 'Werte, die nie ersetzt werden, ohne Groß/klein, auch wenn nur ein Teil erkannt wird' },
  { key: 'skip_attachments', def: "Claude Code's own lists", group: 'tuning', en: 'expert: attachment kinds not checked; unknown kinds are always checked', de: 'Experten: nicht geprüfte Anhangsarten; unbekannte werden immer geprüft' },
  { key: 'preset', def: '', group: 'tuning', en: 'name of an anonym.legal preset', de: 'Name eines anonym.legal-Presets' },
  { key: 'api_url', def: 'https://anonym.legal', group: 'tuning', en: 'service address, https only', de: 'Adresse des Dienstes, nur https' },
  { key: 'allow_other_host', def: 'false', group: 'tuning', en: 'allow api_url with another host (test environments)', de: 'api_url mit anderem Host erlauben (Testumgebungen)' },
]

/** Fertige Profile; jedes ist ein Befehl, der in einer Shell alles auf einmal setzt. */
export const PROFILES: ReadonlyArray<{ name: string; en: string; de: string; values: Record<string, string> }> = [
  { name: 'standard', en: 'defaults (recommended)', de: 'Standard (empfohlen)', values: { leak_guard: 'block', shell_guard: 'block', file_values: 'real', media: 'drop', ignore_types: 'URL,DATE_TIME,NRP,ORGANIZATION' } },
  { name: 'strict', en: 'law firm / health: no real values written to disk', de: 'Kanzlei / Gesundheit: keine echten Werte auf die Platte', values: { leak_guard: 'block', shell_guard: 'block', file_values: 'deny', media: 'drop', encoded_runs: 'strict' } },
  { name: 'development', en: 'source code with few personal data: fewer false matches', de: 'Quellcode mit wenig Personendaten: weniger Scheintreffer', values: { ignore_types: 'URL,DATE_TIME,NRP,ORGANIZATION,IP_ADDRESS', min_score: '0.7' } },
]

const PLUGIN_ID = 'anonym-legal-guard@anonym-legal'

/** Ein Ein-Zeilen-Befehl, der die Werte setzt (Werte als JSON über stdin, siehe `claude plugin configure --help`). */
export function profileCommand(values: Record<string, string>): string {
  // printf statt echo: zsh (macOS) deutet Backslashes in echo, dann wäre das JSON kaputt (Codex 2026-11-18).
  const quoted = JSON.stringify(values).replace(/'/g, "'\\''")
  return `printf '%s\\n' '${quoted}' | claude plugin configure ${PLUGIN_ID} --values-stdin`
}

function shown(key: string, value: unknown): string {
  if (key === 'api_key') return value ? '••• set' : 'NOT SET'
  if (value === undefined || value === null || value === '') return ''
  return String(value)
}

export function settingsReport(options: Record<string, unknown>, lang: Lang, version: string): string {
  const de = lang === 'de'
  const head = de ? `anonym.legal Einstellungen (Mod ${version})` : `anonym.legal settings (mod ${version})`
  const groups: Record<Setting['group'], string> = de
    ? { daily: 'Alltag', guard: 'Schutzschalter (nur mit Grund ändern)', tuning: 'Feinabstimmung' }
    : { daily: 'Everyday', guard: 'Protection switches (change only with a reason)', tuning: 'Fine tuning' }
  const out = [head, de ? 'Leer = Standard. Ändern: /plugin → anonym-legal-guard → Configure, oder ein Profil unten.' : 'Empty = default. Change: /plugin → anonym-legal-guard → Configure, or a profile below.']
  for (const g of ['daily', 'guard', 'tuning'] as const) {
    out.push('', `${groups[g]}:`)
    for (const s of SETTINGS.filter((x) => x.group === g)) {
      const cur = shown(s.key, options[s.key])
      const val = cur === '' ? `${s.def || '–'} (${de ? 'Standard' : 'default'})` : cur === s.def ? `${cur} (${de ? 'Standard' : 'default'})` : `${cur}  ← ${de ? 'geändert' : 'changed'}`
      out.push(`  ${s.key.padEnd(18)} ${val}`)
      out.push(`  ${''.padEnd(18)} ${de ? s.de : s.en}`)
    }
  }
  out.push('', de ? 'Profile (in einer Shell ausführen, dann Claude Code neu starten):' : 'Profiles (run in a shell, then restart Claude Code):')
  for (const p of PROFILES) out.push(`  ${p.name} — ${de ? p.de : p.en}`, `    ${profileCommand(p.values)}`)
  out.push('', de ? 'Alle Typen für ignore_types: https://anonym.legal/entities' : 'All types for ignore_types: https://anonym.legal/entities')
  return out.join('\n')
}
