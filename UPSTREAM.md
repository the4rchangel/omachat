# Omarchy upstream checklist (bots + humans)

Use before opening a PR against `basecamp/omarchy`.

## Process (will get closed if skipped)

- [ ] Post a **Suggestion** in Discussions first: https://github.com/omacom/omarchy/discussions/categories/suggestions
- [ ] Pitch: *Omachat — Hyperswarm P2P lobby, no Omarchy chat server*
- [ ] Wait for maintainer signal before a large packaging PR
- [ ] Fork/clone — never develop in `/usr/share/omarchy`
- [ ] Target default branch (`quattro` as of writing)
- [ ] Prefer shipping Omachat as its own package (AUR/npm); Omarchy PR = thin launch/desktop/manual glue only

## Code (`AGENTS.md`)

- [ ] `#!/bin/bash` shebangs on shell launchers
- [ ] Two-space indent; `[[ ]]` / `(( ))` bash 5 style
- [ ] `# omarchy:summary=` on user-facing `bin/omarchy-*`
- [ ] Use `omarchy-pkg-add`, `omarchy-launch-tui`, `omarchy-notification-send` where applicable
- [ ] Atomic commits; succinct messages
- [ ] `./test/all` green (Omarchy tree)
- [ ] Screenshots for UI

## Security

- [ ] No secrets / identity seeds in the tree
- [ ] Hyperswarm/Noise for transport; document room-name = invite
- [ ] Validate nicks; config files mode `0600`
- [ ] No privileged helpers; client + DHT only
- [ ] Omarchy platform vulns → per Omarchy SECURITY.md

## Packaging pieces (if accepted)

- [ ] Standalone npm/AUR package **or** vendored under optional install
- [ ] `bin/omarchy-launch-omachat` wrapper
- [ ] `applications/Omachat.desktop`
- [ ] Node dependency story (system node vs bundled)
- [ ] Manual blurb under TUIs
- [ ] Migration for users who had the IRC wrapper

Prove the app outside the Omarchy tree first (`npm start` / smoke test). Packaging is step two.
