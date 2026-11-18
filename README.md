<p align="center"><img src="assets/logo.png" alt="anonym.legal" width="96"></p>

# anonym-legal-guard for Claude Code

A mod for [Claude Code](https://docs.claude.com/en/docs/claude-code) by [anonym.legal](https://anonym.legal).
Before text goes to the model, it replaces detected personal data (names, e-mail addresses, IBANs, phone
numbers and more) with placeholders such as `‹PERSON_1·k7p›`. You keep reading and writing the real values.

> **Preview.** Protection against accidents, not against injected instructions and not against intent.
> Detection is not complete. Read [Limits](#limits) before you use it with real data.

## Requirements

- Claude Code **2.1.325** or later (the mod API is early access and changes between versions).
- An anonym.legal account on **Basic, Pro or Business** and its API token (see step 1). Every check is
  billed in tokens like an API call.

## Install

### 1. Get your API token from anonym.legal

1. Sign in at [anonym.legal](https://anonym.legal/auth/signin). No account yet? Register, then choose
   Basic, Pro or Business under [Pricing](https://anonym.legal/pricing). A Free account has no API token.
2. Open **Settings → Developer**: [anonym.legal/app/settings?tab=developer](https://anonym.legal/app/settings?tab=developer).
3. The card **API Access Token** shows your token. It is created the first time you open the tab.
4. Click the **copy** button next to the token.

Keep the token secret: anyone who has it can use your account's tokens. **Regenerate** gives you a new
token and stops the old one at once, also in the anonym.legal Chrome extension, which uses the same token.

### 2. Install the mod

At the prompt of a Claude Code terminal session:

```
/plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

Or from a shell:

```
claude plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

Answer `y` to add the marketplace, then pick a scope: **user** (all your projects) or **project** (only
the current folder).

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with
`georgecurta/anonym-legal-guard`, then **Add plugin**.

### 3. Enter the token

Right after the install, Claude Code shows the mod's options. Paste the token into
**API token (anonym.legal)** (`api_key`) and save. Two more choices in the same dialog:

- **Interface language** (`ui_language`): `en` (default) or `de` for the mod's messages, status line and `/pii`.
- **Detection languages** (`language`): `account` (default) uses the automatic detection languages saved in
  your anonym.legal account (Settings → Language). Or enter codes, for example `de` or `de,en`.

Leave the other options as they are.

To enter or change the token later:

- in a Claude Code session: type `/plugin`, choose **anonym-legal-guard**, then **Configure**;
- or from a shell: `claude plugin configure anonym-legal-guard` lists the options and shows which are not
  set yet.

The token is marked as secret: Claude Code keeps it in its own credential storage, not in your project
files, so it does not end up in a git repository.

### 4. Check that it works

Start a new Claude Code session. The status line shows `anonym.legal: PII protection active`; without a
token it shows `anonym.legal: no API token, prompts are blocked`. Type `/pii` at any time: it shows
`anonym.legal PII protection: active (https://anonym.legal, languages: account (de, en))`, what the mod has
replaced in this session and whether anonym.legal answered.

If the token is missing, wrong or the plan has no access, every prompt is withheld with a message saying
why:

| Message | Meaning | What to do |
|---|---|---|
| `no API token set` | no token entered | step 3 |
| `Token invalid (HTTP 401)` | token wrong or regenerated | copy the current token again (step 1, 3) |
| `Plan without access to the mod (HTTP 403 …)` | Free plan | choose Basic, Pro or Business |
| `No tokens left (HTTP 402)` | no tokens left this month | buy tokens or wait for the next month |
| `The server reported no detection languages for this account` | `account` found no language | set languages in your account or enter codes in `language` |

With `ui_language: de` the same messages appear in German.

## Update

Claude Code does not update the mod on its own unless you switch on auto-update for this marketplace.

- From a shell:

  ```
  claude plugin marketplace update anonym-legal
  claude plugin update anonym-legal-guard
  ```

- In a Claude Code session: type `/plugin`, open **Marketplaces**, choose **anonym-legal** and **Update**; there you
  can also switch on **auto-update**.

Restart Claude Code afterwards; `claude plugin list` shows the installed version. Your token and options stay as they are.
New options in a new version start with their default value.

## Uninstall

- From a shell (use `--scope project` if you installed it for one project only):

  ```
  claude plugin uninstall anonym-legal-guard
  claude plugin marketplace remove anonym-legal
  ```

- In a Claude Code session: type `/plugin`, choose **anonym-legal-guard**, then **Uninstall**.
- To switch it off for a while instead: `claude plugin disable anonym-legal-guard` (`enable` turns it back on).

Restart Claude Code afterwards. From then on prompts go to the model **without** replacement. If you no longer want
the token to work, click **Regenerate** under Settings → Developer on anonym.legal; that also stops the old token in
the Chrome extension. Your anonym.legal account and plan stay as they are.

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
- **Languages:** by default the mod uses your account's detection languages (`account`); or set `language` to
  the languages of your texts, for example `de` or `de,en` (at most three).
  Each extra language checks every text again and costs tokens. Since 2026-11-18 the server keeps a name hit
  only in sentences of its own language: measured on German text with `de,en`, ordinary words such as
  "Vorgang" or "Befund" were no longer replaced, and English names in the same text were found. Before that
  fix such words were replaced; detection still misses things in either setting.
- **Token counting:** Claude Code counts large tool results with a separate request before the mod has seen
  them. The mod does not let that request out; Claude Code then works without the count.
- **Interface languages:** English (default) and German. The option labels in Claude Code's dialog are English.

## Options

| Option | Default | Meaning |
|---|---|---|
| `api_key` | – | your anonym.legal API token (stored as a secret) |
| `ui_language` | `en` | language of messages, status line and `/pii`: `en` or `de` |
| `language` | `account` | detection languages: `account` (from your anonym.legal account) or codes such as `de`, `de,en` |
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
