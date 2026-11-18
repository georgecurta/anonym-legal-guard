<p align="center"><img src="assets/logo.png" alt="anonym.legal" width="96"></p>

# anonym-legal-guard for Claude Code

A mod for [Claude Code](https://docs.claude.com/en/docs/claude-code) by [anonym.legal](https://anonym.legal).
Before text goes to the model, it replaces detected personal data (names, e-mail addresses, IBANs, phone
numbers and more) with placeholders such as `‹PERSON_1·k7p›`. You keep reading and writing the real values.

> **Preview.** Protection against accidents, not against injected instructions and not against intent.
> Detection is not complete. Read [Limits](#limits) before you use it with real data.

## Requirements

- Claude Code **2.1.325** or later (the mod API is early access and changes between versions).
- An anonym.legal account on **Basic, Pro or Business** and its API token
  ([create one in your account](https://anonym.legal)). Every check is billed in tokens like an API call.

## Install

At the prompt of a terminal session:

```
/plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

From a shell:

```
claude plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

Answer `y` to add the marketplace, pick a scope, then enter your API token on the options screen. In the
desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `georgecurta/anonym-legal-guard`, then
**Add plugin**.

Without a token every prompt is withheld with a message saying why.

## What it does

| Where | What happens |
|---|---|
| Your prompts, files the model reads, command output, attachments, summaries | sent to anonym.legal for detection; detected values are replaced before the model sees them |
| Values already seen in this session | replaced everywhere else too, without a new request, also in other upper/lower case |
| base64 and hex sections | decoded and checked; a section in which personal data is detected is withheld |
| Files the model writes | the mod puts the real values back in, on your machine |
| Tools that go outside (`WebFetch`, `WebSearch`, MCP tools, `Agent`, `Monitor`, shell) | get placeholders; an argument with a known value in clear text is refused |
| Every request to the model | searched for known values in clear or encoded form; a clear leak stops the request |
| Encoders and uploads in the shell (`base64 file`, `xxd`, `curl -d @file`, …) | refused; `scp`, `sftp`, `rsync` to a host and `tar c … \|` ask first |

`/pii` shows what the mod did in this session, its switches and whether anonym.legal answered.

The mapping between placeholder and real value stays in the session on your machine. anonym.legal does not
keep it.

## Limits

- **Detection misses things.** What it does not detect goes to the model. Other encodings (rot13, own
  tables) go through. Lower-case names are not replaced.
- **No protection against injected instructions** in documents you let the model read, and none against a
  user who wants to get around it. The mod runs on your machine and can be switched off.
- **Writing files puts the real values back.** A script written that way can print them again in a form the
  mod does not know. Set `file_values: deny` (strict mode) to stop the model writing files with placeholders.
- **The local transcript of Claude Code contains clear text** (under `~/.claude/projects/`). That is Claude
  Code's file, not the mod's. Retention and deletion are up to you.
- **Auto permission mode:** the model that approves tool calls can receive real values. With
  `leak_guard: block` (default) the mod stops that request. Use auto mode with the mod only with `block` or
  strict mode.
- **`--safe-mode`,** or three crashes of the mod runtime, switch the mod off.
- **After `--resume`,** old placeholders cannot be translated back; writing with them is refused.
- **Team and Enterprise sign-ins:** Claude Code can run its own built-in guard first; a mod you install
  yourself may then not see every input. For organisations, deploy it as a managed mod.
- **Languages:** set `language` to the languages of your texts, for example `de` or `de,en` (at most three).
  Each extra language checks every text again and costs tokens. Since 2026-11-18 the server keeps a name hit
  only in sentences of its own language: measured on German text with `de,en`, ordinary words such as
  "Vorgang" or "Befund" were no longer replaced, and English names in the same text were found. Before that
  fix such words were replaced; detection still misses things in either setting.
- **Token counting:** Claude Code counts large tool results with a separate request before the mod has seen
  them. The mod does not let that request out; Claude Code then works without the count.
- **Messages are in German** for now.

## Options

| Option | Default | Meaning |
|---|---|---|
| `api_key` | – | your anonym.legal API token (stored as a secret) |
| `language` | `de` | detection language; one language is best (see Limits) |
| `leak_guard` | `block` | `block` stops clear leaks, `log` only reports, `off` |
| `shell_guard` | `block` | `block` refuses encoders and uploads, `ask` asks for everything, `off` |
| `encoded_runs` | `scan` | `scan` checks decodable sections, `strict` also withholds long binary runs, `off` |
| `file_values` | `real` | `real` writes real values to files, `deny` refuses writes with placeholders |
| `media` | `drop` | images and documents are withheld; `keep` sends them unchecked |

## Your data

See [PRIVACY.md](PRIVACY.md): what goes to anonym.legal, what goes to the model provider, what stays on your
machine. Processing by anonym.legal is covered by the anonym.legal
[terms](https://anonym.legal/terms) and [data processing agreement](https://anonym.legal/legal/dpa).
Your contract with the model provider (Anthropic) is your own.

## Security

Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Licence

The code of this mod is under the [MIT licence](LICENSE). The anonym.legal service it calls is not; it needs
a paid plan.
