// /pii-settings (0.7.2): alle Optionen mit aktuellem Wert, Standard und Erklärung, dazu fertige Profile.
// Grund (0.7.2): Claude Code zeigt im Dialog jede Option als „not set“ und nennt den
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

/**
 * Ein Ein-Zeilen-Befehl, der die Werte setzt (Werte als JSON über stdin, siehe `claude plugin configure --help`).
 * Alle Werte stehen als Text im JSON, auch Zahlen und Schalter: gemessen am 2026-11-20 mit Claude Code 2.1.329
 * nimmt `--values-stdin` nur „a JSON object of strings“ an, wandelt den Text selbst in die Art des Manifests und
 * weist `0.7` oder `true` als echte JSON-Werte ab.
 */
export function profileCommand(values: Record<string, string>): string {
  // printf statt echo: zsh (macOS) deutet Backslashes in echo, dann wäre das JSON kaputt.
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

// ── /pii-setup (0.9): eine geführte Einrichtung, die nichts selbst ändert ──────────────────────────────
// Der Token geht nur über den Configure-Dialog von Claude Code (das Feld ist `sensitive`); ihn fragt der Mod nie
// ab. Die Optionen setzt ein Befehl in der Shell: jede Änderung lädt den Mod neu, und mehrere Optionen lassen sich
// aus dem Mod heraus nicht gemeinsam setzen. Reine Funktionen, ohne Netz testbar.

const SETUP_LANGUAGES: ReadonlyArray<{ value: string; en: string; de: string }> = [
  { value: 'account', en: 'Account default', de: 'Konto-Standard' },
  { value: 'de', en: 'German (de)', de: 'Deutsch (de)' },
  { value: 'en', en: 'English (en)', de: 'Englisch (en)' },
  { value: 'de,en', en: 'German + English', de: 'Deutsch + Englisch' },
]
const SETUP_PROFILES: ReadonlyArray<{ name: string; en: string; de: string }> = [
  { name: 'standard', en: 'Standard (recommended)', de: 'Standard (empfohlen)' },
  { name: 'strict', en: 'Strict (law firm, health)', de: 'Streng (Kanzlei, Gesundheit)' },
  { name: 'development', en: 'Development (source code)', de: 'Entwicklung (Quellcode)' },
]

export type SetupQuestion = { question: string; header: string; options: string[] }

/** Die zwei Fragen des Assistenten: Erkennungssprache und Profil. Die Antworten sind feste Wörter, nie Werte. */
export function setupQuestions(lang: Lang): { language: SetupQuestion; profile: SetupQuestion } {
  const de = lang === 'de'
  return {
    language: {
      question: de ? 'In welchen Sprachen soll anonym.legal Personendaten erkennen?' : 'In which languages should anonym.legal detect personal data?',
      header: de ? 'Sprache' : 'Language',
      options: SETUP_LANGUAGES.map((l) => (de ? l.de : l.en)),
    },
    profile: {
      question: de ? 'Welches Profil passt zu deiner Arbeit?' : 'Which profile fits your work?',
      header: de ? 'Profil' : 'Profile',
      options: SETUP_PROFILES.map((p) => (de ? p.de : p.en)),
    },
  }
}

export type SetupPlan = { language: string; profile: string; command: string; isDefault: boolean }

/**
 * Aus den Antworten wird ein Befehl. Eine Antwort gilt nur, wenn sie genau eine der angebotenen ist; alles
 * andere (freie Eingabe, Abbruch, kein Dialog) ergibt den Standard und wird nirgends ausgegeben. `isDefault`:
 * Konto-Standard und Profil Standard sind die Werte, die ohnehin gelten; dafür braucht es keinen Befehl.
 */
export function setupPlan(answers: { language?: string; profile?: string }, lang: Lang): SetupPlan {
  const de = lang === 'de'
  const language = SETUP_LANGUAGES.find((l) => (de ? l.de : l.en) === answers.language)?.value ?? 'account'
  const profile = SETUP_PROFILES.find((p) => (de ? p.de : p.en) === answers.profile)?.name ?? 'standard'
  const values = PROFILES.find((p) => p.name === profile)?.values ?? {}
  return { language, profile, command: profileCommand({ ...values, language }), isDefault: language === 'account' && profile === 'standard' }
}

/**
 * Erster Schritt, solange kein Token gesetzt ist: nur der Weg zum Token. Den Token speichert der Einstellungsdialog
 * von Claude Code als Geheimnis; der Mod kann ein solches Feld nicht setzen und nimmt den Token nie selbst an.
 * `configure` ist der Befehl, der diesen Dialog direkt öffnet (der Mod stößt ihn zusätzlich selbst an).
 */
export function setupTokenText(input: { lang: Lang; stateLine: string; configure: string; replace?: boolean }): string {
  const de = input.lang === 'de'
  return [
    de ? 'anonym.legal einrichten' : 'Set up anonym.legal',
    input.stateLine,
    '',
    de
      ? '1. Token kopieren: https://anonym.legal/app/settings?tab=developer öffnen, anmelden und unter „API Access Token“ auf Kopieren klicken. Das Konto braucht den Tarif Basic, Pro oder Business.'
      : '1. Copy your token: open https://anonym.legal/app/settings?tab=developer, sign in and click Copy under "API Access Token". The account needs a Basic, Pro or Business plan.',
    de
      ? `2. Token einfügen: der Einstellungsdialog öffnet sich jetzt. Wenn nicht: ${input.configure} eingeben. Im ersten Feld „API token (anonym.legal)“ den Token einfügen, dann unten „Save“ wählen. Alle anderen Felder haben Standardwerte.`
      : `2. Paste the token: the settings dialog opens now. If it does not, type ${input.configure}. Paste the token into the first field, "API token (anonym.legal)", then choose "Save" at the bottom. All other fields have defaults.`,
    // Der Dialog lässt bei leerem Feld den alten Wert stehen (gemessen 2026-11-20): löschen geht nicht, ersetzen ja.
    ...(input.replace
      ? [
          de
            ? '   Es ist schon ein Token eingetragen, aber er ist ungültig oder abgelaufen. Der neue Token ersetzt den alten; ein leeres Feld lässt den alten stehen.'
            : '   A token is already stored, but it is invalid or expired. The new token replaces the old one; an empty field keeps the old one.',
        ]
      : []),
    de ? '3. Prüfen: /pii zeigt „geschützt“. Mehr ist nicht nötig.' : '3. Check: /pii shows "protected". Nothing else is needed.',
    '',
    de
      ? 'Sprache oder Profil ändern (optional): danach noch einmal /pii-setup. Der Token wird von Claude Code als Geheimnis gespeichert; der Mod fragt ihn nie ab.'
      : 'To change language or profile (optional): run /pii-setup again afterwards. Claude Code stores the token as a secret; the mod never asks for it.',
  ].join('\n')
}

/** Zweiter Schritt, wenn der Token gesetzt ist: Sprache und Profil. Die Standardwahl braucht keinen Befehl. */
export function setupOptionsText(input: { lang: Lang; stateLine: string; plan: SetupPlan }): string {
  const de = input.lang === 'de'
  const head = [de ? 'anonym.legal einrichten' : 'Set up anonym.legal', input.stateLine, '']
  if (input.plan.isDefault) {
    return [
      ...head,
      de
        ? 'Sprache: Konto-Standard, Profil: Standard. Das sind die Werte, die schon gelten; es ist nichts zu ändern.'
        : 'Language: account default, profile: standard. These already apply; there is nothing to change.',
      de ? 'Alle Optionen mit Standard: /pii-settings' : 'All options with their defaults: /pii-settings',
    ].join('\n')
  }
  return [
    ...head,
    de
      ? `Sprache (${input.plan.language}) und Profil (${input.plan.profile}) setzen, in einer Shell, nicht hier im Chat:`
      : `Set language (${input.plan.language}) and profile (${input.plan.profile}), in a shell, not here in the chat:`,
    `   ${input.plan.command}`,
    de ? 'Danach Claude Code neu starten und mit /pii prüfen.' : 'Then restart Claude Code and check with /pii.',
    '',
    de ? 'Diese Anleitung ändert nichts selbst. Alle Optionen mit Standard: /pii-settings' : 'Nothing is changed by this guide. All options with their defaults: /pii-settings',
  ].join('\n')
}

/** Ein Fehler, den weder Token noch Profil beheben (Guthaben, Tarif, Netz, Sprache, Adresse): Zustand und nächster Schritt. */
export function setupStateText(input: { lang: Lang; stateLine: string }): string {
  const de = input.lang === 'de'
  return [
    de ? 'anonym.legal einrichten' : 'Set up anonym.legal',
    input.stateLine,
    '',
    de ? 'Erst das beheben, dann noch einmal /pii-setup oder /pii.' : 'Fix this first, then run /pii-setup or /pii again.',
  ].join('\n')
}
