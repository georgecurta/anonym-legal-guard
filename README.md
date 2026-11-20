<p align="center"><img src="assets/logo.png" alt="anonym.legal" width="96"></p>

# anonym-legal-guard for Claude Code

A mod for [Claude Code](https://docs.claude.com/en/docs/claude-code) by [anonym.legal](https://anonym.legal).
Before text goes to the model, it replaces detected personal data (names, e-mail addresses, IBANs, phone
numbers and more) with placeholders such as `‹PERSON_1·k7p›`. In the terminal and the desktop app (as long as no other surface is attached) you read the
answers with the real values; files Claude writes get the real values back.

> **Preview.** Protection against accidents, not against injected instructions and not against intent.
> Detection misses values. Read [Limits](#limits) before you use it with real data.

## Where it works

| Client | Status | Notes |
|---|---|---|
| Claude Code in the terminal (CLI) | Supported (measured) | Protection, status line, side panel and band. Answers show the real names. |
| Claude Code desktop app | Supported (measured) | Same as the terminal. Real names in answers only while no other surface is attached (for example Remote Control). |
| VS Code (Claude Code extension) | Expected (unmeasured) | Uses the same Claude Code, so protection is expected. Answers show placeholders. |
| JetBrains IDEs (Claude Code plugin) | Expected (unmeasured) | Same as VS Code: uses the same Claude Code installation, so protection is expected. Display not measured; answers show placeholders. |
| Headless (`claude -p`, CI, scripts) | Protection runs | No status line, side panel or dialogs. A withheld prompt ends with an error message. `/pii` prints its text where commands print text; `/pii-setup` prints the steps without asking. |
| Remote Control (phone or browser attached to a local session) | Placeholders only | The attached device shows placeholders, not real names. Unmeasured. |
| **Claude Code on the web (claude.ai/code)** | **Not supported** | See below. |
| Claude mobile app (cloud sessions) | Not supported | Cloud sessions run like Claude Code on the web. |
| Claude in Slack | Not supported | Runs in Anthropic's cloud like Claude Code on the web. |
| claude.ai chat (not Claude Code) | Not applicable | The mod is for Claude Code only. For chats in the browser, the [anonym.legal Chrome extension](https://anonym.legal/features/chrome-extension) detects and anonymizes personal data before you send a message to Claude, ChatGPT, Gemini and other AI chatbots. |

Real names appear in the terminal and in the desktop app (as long as no remote access is attached), because
there the mod assumes that the display stays on your machine (the surface reports its own name). Files Claude writes get the real values
everywhere (`file_values: real`, the default).

### Not supported: Claude Code on the web

Do not rely on the mod in Claude Code on the web (claude.ai/code):

1. Anthropic receives the prompt there in plain text first; the session title, for example, is built from it.
2. The mapping between placeholder and real value would sit on Anthropic's cloud machine instead of your computer.
3. Answers keep the placeholders, and the status line and side panel do not appear.

## Requirements

- Claude Code **2.1.325** or later (the mod API is early access and changes between versions).
- An anonym.legal account on **Basic, Pro or Business** and its API token (see step 1). Every check is
  billed in tokens like an API call.

## Install (3 steps)

In short: copy your token, install the mod and enter the token, check with `/pii`. Inside Claude Code,
`/pii-setup` walks you through it: it tells you where to copy the token and opens the settings dialog, where
you paste it into the first field. Claude Code stores the token as a secret; the mod never asks for it and
cannot read it from a dialog. Once the token is set, `/pii-setup` offers language and profile; the defaults
need no further step.

```
/plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

### 1. Copy your API token from anonym.legal

1. Sign in at [anonym.legal](https://anonym.legal/auth/signin). No account yet? Register, then choose
   Basic, Pro or Business under [Pricing](https://anonym.legal/pricing). A Free account has no API token.
2. Open **Settings → Developer**: [anonym.legal/app/settings?tab=developer](https://anonym.legal/app/settings?tab=developer).
3. The card **API Access Token** shows your token. It is created the first time you open the tab.
4. Click the **copy** button next to the token.

Keep the token secret: anyone who has it can use your account's tokens. **Regenerate** gives you a new
token and stops the old one at once, also in the anonym.legal Chrome extension, which uses the same token.

### 2. Install the mod and enter the token

At the prompt of a Claude Code terminal session:

```
/plugin install anonym-legal-guard --marketplace georgecurta/anonym-legal-guard
```

Or from a shell:

```
claude plugin marketplace add georgecurta/anonym-legal-guard
claude plugin install anonym-legal-guard@anonym-legal
```

Answer `y` to add the marketplace, then pick a scope: **user** (all your projects) or **project** (only
the current folder).

In the desktop app: **Plugins → Add → Add marketplace → URL `georgecurta/anonym-legal-guard` → Sync** (it accepts only a GitHub owner/repo or a Git URL),
then install the mod. If you already installed the mod in the
terminal, the desktop app has it too ("Installed locally"); adding the marketplace again reports "A marketplace
with the same name … already exists".

Then enter the token: type `/plugin`, choose **anonym-legal-guard**, then **Configure**, paste the token into
**API token (anonym.legal)** (`api_key`) and save. Only `api_key` needs a value; every other option has a
default. Two you may want to set in the same dialog:

- **Interface language** (`ui_language`): `en` (default) or `de` for the mod's messages, status line and `/pii`.
- **Detection languages** (`language`): `account` (default) uses the automatic detection languages saved in
  your anonym.legal account (Settings → Language). Or enter codes, for example `de` or `de,en`.

Leave the other options as they are.

To enter or change the token later:

- in a Claude Code session: type `/plugin`, choose **anonym-legal-guard**, then **Configure**;
- or from a shell: `claude plugin configure anonym-legal-guard` lists the options and shows which are not
  set yet.

The token is stored by Claude Code's configure dialog: Claude Code keeps sensitive values in its secure
storage, not in your project files, so it does not end up in a git repository. The mod itself cannot set
the token.

### 3. Check with `/pii`

Type `/pii`. The status line shows `🛡 anonym.legal · protected` only after the check with the anonym.legal
server has succeeded. `/pii` also shows what the mod has replaced in this session and whether anonym.legal
answered.

If the token is missing, wrong or the plan has no access, every prompt is withheld, and a band above the input
names the problem and the next step:

| Message | Meaning | What to do |
|---|---|---|
| `no API token set` | no token entered | step 2 |
| `Token invalid (HTTP 401)` | token wrong or regenerated | copy the current token again (step 1, 2) |
| `Plan without access to the mod (HTTP 403 …)` | Free plan | choose Basic, Pro or Business |
| `No tokens left (HTTP 402)` | no tokens left this month | buy tokens or wait for the next month |
| `The server reported no detection languages for this account` | `account` found no language | set languages in your account or enter codes in `language` |

## Firewall view

The mod shows states and counts, never the values themselves.

- **Status line:** `🛡 anonym.legal · protected · N replaced · M blocked`. It says `protected` only after a
  successful check with the server; otherwise a note below the input says what to do next.
- **Side panel:** in the terminal and the desktop app, `/pii` opens it on the right (it needs a wide window): state, last check and
  counts per type, such as names or IBANs.
- **Notice when something is stopped:** when the mod stops a file tool call, a shell command, a tool call that
  would have sent a redacted value, a request to the model, or a message to a subagent, a short notice says so, at most once per kind
  every 10 seconds. It carries no values and no placeholders. Replacements raise no notice; the counts are
  in the status line. Measured in the terminal (top right, gone after a few seconds); not yet checked in the
  desktop app.
- **Blocking band:** above the input when a prompt is withheld, with the problem and the next step.

Checked in the terminal and in the desktop app; not yet checked in VS Code. None of these appear in Claude
Code on the web.

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

When Claude Code runs on your machine (terminal, desktop app; VS Code is expected to work but is unmeasured), the mapping between placeholder and
real value stays in the session there. anonym.legal does not keep it.

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
- **`--safe-mode`** switches off a mod you installed yourself; a mod your organization manages stays on. A crash
  traced to the mod can unload it. Both are taken from the Claude Code documentation and not measured here.
  While the mod is off, nothing is protected.
- **After `--resume`,** old placeholders cannot be translated back; writing with them is refused.
- **Real names on screen only in the terminal and the desktop app** (as long as no remote access is attached).
  VS Code, Remote Control and other surfaces show placeholders. **Claude Code on the web is not supported** (see [Where it works](#where-it-works)).
- **Not checked: `gitStatus` and results of the built-in web search.** Claude Code adds `gitStatus` (branch, recent commit messages) to the request itself, and the mod does not rewrite it; results of the API's own web search arrive on the provider side and are not checked either. Images in the prompt can only be refused. Keep personal data out of both.
- **If the display fails inside Claude Code itself,** the app may show the original tool line; on a remote
  surface that would be real values.
- **The desktop app shows real values as long as it is the only attached surface.** Each surface reports its
  own name; this protects against accidents, it is not a check.
- **Team and Enterprise sign-ins:** Claude Code can run its own built-in guard first; a mod you install
  yourself may then not see every input. Central rollout for organisations is in preparation; until then each
  person installs the mod.
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

Claude Code lists every option as "not set" until you change it. **An option you leave empty uses the default
below**; the mod applies it itself. Only `api_key` must be filled in. Options with a fixed list of values refuse
anything else when you save.

**Everyday options**

| Option | Default (if left empty) | Meaning |
|---|---|---|
| `api_key` | – (required) | your anonym.legal API token, stored as a secret |
| `ui_language` | `en` | language of messages, status line and `/pii`: `en` or `de` |
| `language` | `account` | detection languages: `account` (the automatic languages in your anonym.legal account) or up to three codes such as `de`, `de,en`; each extra language checks every text again and costs tokens |
| `file_values` | `real` | `real`: files the model writes get the real values; `deny` (strict mode): writes with placeholders are refused |
| `media` | `drop` | `drop`: images and documents are withheld (they cannot be redacted); `keep`: sent unchecked |

**Protection switches** (leave them on their defaults unless you have a reason)

| Option | Default (if left empty) | Meaning |
|---|---|---|
| `leak_guard` | `block` | checks every request to the model and the arguments of outbound tools for known values, also encoded; `block` replaces a known value in clear text by its placeholder and stops what it cannot replace, `log` only reports, `off` |
| `shell_guard` | `block` | `block` refuses encoders and uploads and asks for `scp`, `sftp`, `rsync`, `tar c … \|`; `ask` asks for all of them; `off` |
| `encoded_runs` | `scan` | base64 (from 16 characters) and hex (from 32): `scan` checks decodable sections, `strict` also withholds long undecodable ones, `off` |
| `detokenize_bash` | off | on: shell commands get real values instead of placeholders; a command can then send them to the network |
| `scan_hook_context` | on | also checks the output of hooks from your settings |

**Fine tuning**

| Option | Default (if left empty) | Meaning |
|---|---|---|
| `min_score` | `0.5` | matches below this score (0 to 1) are not replaced |
| `ignore_types` | `URL,DATE_TIME,NRP,ORGANIZATION` | entity types that are not replaced (in code these are mostly false matches) |
| `allow_values` | names of Claude and Anthropic | comma-separated values that are never replaced |
| `skip_attachments` | Claude Code's own tool, skill and agent lists | attachment kinds that are not checked; unknown kinds are always checked |
| `preset` | none | name of an anonym.legal preset, e.g. `developer` |
| `api_url` | `https://anonym.legal` | address of the service; https only |
| `allow_other_host` | off | allows an `api_url` with another host (e.g. a test environment); while off, such an address withholds every prompt |

**See and change them quickly.** In a Claude Code session, `/pii-settings` lists every option with its current
value, its default and a one-line explanation, and prints three ready-made profiles as commands:

| Profile | For | Sets |
|---|---|---|
| `standard` | most users | the defaults |
| `strict` | law firms, health data (protection against accidents, see Limits) | `file_values: deny` (no real values written to disk), `encoded_runs: strict` |
| `development` | source code with few personal data | adds `IP_ADDRESS` to `ignore_types`, `min_score: 0.7` |

A profile is one line for bash or zsh (macOS, Linux, WSL); `/pii-settings` prints each one ready to copy, for example:

```
printf '%s\n' '{"file_values":"deny","encoded_runs":"strict"}' | claude plugin configure anonym-legal-guard@anonym-legal --values-stdin
```

Restart Claude Code afterwards.

### Ignoring types and values

- **`ignore_types`** takes entity types, comma-separated, exactly as the detection names them. Common ones:
  `PERSON`, `EMAIL_ADDRESS`, `PHONE_NUMBER`, `IBAN_CODE`, `CREDIT_CARD`, `IP_ADDRESS`, `LOCATION`, `ORGANIZATION`,
  `DATE_TIME`, `URL`, `NRP` (nationality, religious or political group), `MEDICAL_LICENSE`. The full list with
  all country-specific types is at [anonym.legal/entities](https://anonym.legal/entities). A type in this list
  is never replaced, so it also reaches the model. Setting the option replaces the default list; keep
  `URL,DATE_TIME,NRP,ORGANIZATION` in it unless you want those replaced.
- **`allow_values`** takes words or phrases, comma-separated. Matching ignores upper and lower case and only
  counts whole words. A hit that lies inside an allowed phrase is also kept: with `Claude Code` allowed, `Code`
  in "Claude Code" is never replaced. Setting the option replaces the default list (names of Claude and
  Anthropic).
- **`skip_attachments`** is for experts. It names kinds of attachments that Claude Code writes itself (tool,
  skill and agent lists). Kinds not in the list are always checked. Leave it empty.
- **Not personal data, never replaced:** loopback addresses (`127.0.0.1`, `::1`, `0.0.0.0`), and matches in the
  middle of a hex or digit string (for example inside a Git commit hash).

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
