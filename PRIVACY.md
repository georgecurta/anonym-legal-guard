# Data flows of anonym-legal-guard

Measured with Claude Code 2.1.325 against the anonym.legal test environment (2026-11-16/17), not against the
production service. Not a legal opinion.

| Data | Goes to | Note |
|---|---|---|
| Text that would go to the model: prompts, file contents, command output, attachments, summaries, decoded base64/hex sections | **anonym.legal**, `https://anonym.legal/api/mcp/analyze`, over HTTPS | for detection only; how anonym.legal stores and logs is described in its [privacy policy](https://anonym.legal/privacy) |
| The same text with detected values replaced | **your model provider** (Anthropic) | this is Claude Code's own connection; anonym.legal is not part of it |
| Values the detection missed | **your model provider** | see Limits in the README |
| Mapping placeholder ↔ real value | **stays in the session on your machine** | measured: no file under `~/.claude` other than the transcript holds it |
| Clear text of files the model read | **Claude Code's local transcript** (`~/.claude/projects/…`) | written by Claude Code, not by the mod |

The mod calls no other host, unless you point `api_url` elsewhere and switch on `allow_other_host`. In the
measured sessions its only connection was anonym.legal.

**Roles.** For the detection, anonym.legal processes the text on your behalf under its
[data processing agreement](https://anonym.legal/legal/dpa). Your use of the model provider is your own
contract with them.

**Your part.** Check `/pii` before you start. Do not use the mod with special categories of data or
professional secrets until your organisation has approved it. Let the model read only documents you trust.
Handle Claude Code's local transcript under your own retention rules.
