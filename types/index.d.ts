// Vertrag der Werte, die der Mod in `$.state` hält.

/** Die Zuordnung einer Sitzung. Sie bleibt auf diesem Rechner; anonym.legal kennt sie nicht. */
export type Vault = {
  /** zufälliger Tag dieser Sitzung, Teil jedes Platzhalters (‹PERSON_1·k7p›) */
  tag: string
  /** `TYP\u0000Wert` → Platzhalter */
  byValue: Record<string, string>
  /** Platzhalter → Wert */
  byToken: Record<string, string>
  /** höchste vergebene Nummer je Typ */
  counter: Record<string, number>
  /** Teile eines Namens (`Mustermann` aus `Erika Mustermann`) → Platzhalter des ganzen Namens */
  aliases: Record<string, string>
  /** wie oft insgesamt ersetzt wurde */
  replaced: number
}

/** Was die Statuszeile und `/pii` zeigen. */
export type GuardStats = {
  /** geprüfte Zeilen */
  scanned: number
  /** Zeilen, die zurückgehalten wurden, weil die Prüfung scheiterte */
  withheld: number
  /** Anfragen ans Modell, in denen ein bekannter Originalwert stand */
  leaks: number
  /** davon gestoppt */
  blocked: number
  /** ersetzte kodierte Abschnitte (base64, Hex) */
  encoded?: number
  /** Ergebnis des Vorwärmens je Sprache: `bereit`/`ready` oder der Fehler; im Kontomodus unter `account`, z. B. `ready: de,en` */
  warm?: Record<string, string>
  /** letzte Fehlermeldung der Erkennung */
  lastError?: string
}

declare module 'claude-code' {
  interface PluginState {
    'anonym-legal-guard': {
      vault: Shaped<Vault>
      stats: Shaped<GuardStats>
      /** Dateien, in die der Mod beim Schreiben echte Werte eingesetzt hat (nur Auskunft, endet mit der Sitzung) */
      tainted: Shaped<string[]>
    }
  }
}
