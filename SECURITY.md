# Security

Please report a vulnerability privately to **support@anonym.legal** with the subject
`Security: anonym-legal-guard`. Do not open a public issue for it.

Include the Claude Code version (`claude --version`), the mod version (`/pii`), the steps to reproduce and,
if you can, a session log made with `claude --debug-file <file>` with any personal data removed.

**In scope:** a way in which a value the mod has detected, or a value already known in the session, reaches
the model in clear text, or reaches a tool that goes outside, without the mod stopping or reporting it.

**Known and documented, not a vulnerability:** values the detection does not find, encodings the mod does
not know, injected instructions in documents, a user switching the mod off, Claude Code's local transcript.
See Limits in the README.
