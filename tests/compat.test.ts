// Kompatibilität mit Claude Code 2.1.325 (in der Desktop-App gebündelt). Ein Bauteil im `ui.render`-Matcher,
// das die Engine nicht kennt, lässt die Registrierung scheitern; dann fehlen ALLE Schutz-Hooks (Anlass:
// `AgentRow`, erst ab 2.1.326). Die Liste ist `RenderComponent` aus claude-code.d.ts 2.1.325.
// Der Test sieht nur `SHOWN` (das Test-Kit lässt keine Dateizugriffe zu). Den ganzen Quelltext (alle
// `component:`, `on('…')` und `$.noun.verb(`) gegen die Typdatei prüft ein eigenes Kompatibilitätsskript der Entwicklung.

import { expect, test } from 'claude-code/testing'

import { SHOWN } from '../hooks/register'

const CC_2_1_325_COMPONENTS = new Set([
  'AskUserQuestion', 'UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress', 'CommandOutput',
  'Spinner', 'TurnDuration', 'InfoNotice', 'SessionMode', 'PromptHint', 'AbovePrompt', 'AbovePromptList', 'Pane', 'Placed', 'Backdrop',
])

test('2.1.325: jedes Bauteil im Render-Matcher (SHOWN) gibt es in 2.1.325, AgentRow nicht', () => {
  expect(SHOWN.length > 5).toBe(true) // Muss-Treffer: die Liste ist da
  expect(SHOWN.filter((c) => !CC_2_1_325_COMPONENTS.has(c))).toEqual([])
  expect((SHOWN as readonly string[]).includes('AgentRow')).toBe(false)
  // Gegenprobe: die Liste erkennt AgentRow als fehlend
  expect(CC_2_1_325_COMPONENTS.has('AgentRow')).toBe(false)
})
