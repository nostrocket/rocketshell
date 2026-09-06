---
name: nostrocket
description: Find actionable NIP-1971 problems and inspect, list, claim, or patch problems in the Nostrocket DAG, including installing and pairing the Notary NIP-46 signer. Use for available work, open leaves, problem children, problem status, Notary setup, contributor claims, and solution proof publication. Contributor-only; excludes maintainer revisions and merit requests.
---

# Nostrocket

Use the bundled command from any directory. Resolve paths relative to this file.

```bash
bash scripts/nostrocket.sh actionable
bash scripts/nostrocket.sh inspect '<problem-id>'
bash scripts/nostrocket.sh children '<problem-id>'
bash scripts/nostrocket.sh claim '<problem-id>'
bash scripts/nostrocket.sh patch '<problem-id>' --proof '<https-url>'
bash scripts/nostrocket.sh notary-status
bash scripts/nostrocket.sh install-notary
```

`actionable` always starts at the project root compiled into the command. Never
ask for a root ID. “Open leaves” means `actionable`.

Before the first write, run the read-only setup check:

```bash
bash scripts/nostrocket.sh notary-status
```

Follow its exact next step:

- `not installed`: tell the user Notary is required and ask them to explicitly
  invoke `$nostrocket install-notary`. Do not install it from a claim, patch, or
  connect request.
- `installed, not connected`: tell the user to copy the `bunker://` URI from
  Notary and run the command below in their local terminal.
- `ready`: continue the requested claim or patch.

Install and connect only through these commands:

```bash
bash scripts/nostrocket.sh install-notary
bash scripts/nostrocket.sh connect
```

Run `install-notary` only after an explicit user request to install Notary. Never
run it implicitly from `claim`, `patch`, or `connect`. It supports macOS Apple
Silicon only, detects both system and user Applications folders, downloads the
official installer pinned to a reviewed commit, verifies that installer's
SHA-256, then lets the official installer download the latest release and verify
its published digest when available. The official installer installs
`Notary.app`, clears its quarantine attribute, and opens it. When Notary
already exists, report its path and change nothing.

`connect` owns a hidden interactive prompt. When tool execution does not expose
that PTY directly to the user, do not launch `connect`: the agent cannot safely
relay the secret. Give the user the exact local command, ask them to paste the
`bunker://` URI there, and resume after they report success. Never request the
URI in chat, read it from the clipboard, or place it in tool input or output.

The command requests only
`get_public_key` and `sign_event:1111`, then stores the NIP-46 client session in
a mode-0600 user configuration file. Treat that file as a credential. Never
print, log, commit, or pass bunker URIs or `nbunksec` values as command-line
arguments. Run `connect` in an interactive PTY.

## Behavior

- `actionable`: list reachable descendants whose selected current revision is
  `open`, has no selected current children, has no effective unexpired claim,
  and has no unresolved equal-timestamp current-head fork.
- `inspect`: show selected revision, status, description, children, and effective
  claim. Report an unresolved current head instead of guessing.
- `children`: list selected direct children only, not recursive descendants.
- `claim`: preflight the same actionable rules for the target, request a
  Notary NIP-46 signature, validate the signed kind-1111 event, and publish it.
- `patch`: require an `https://` proof URL, reference the selected current
  revision, request a Notary signature, validate, and publish it.
- `notary-status`: report whether Notary is absent, installed but unpaired, or
  ready without reading or printing signer credentials.
- `install-notary`: explicitly install official Notary on supported Macs; never
  run as an automatic fallback.

Claims and patches are public, irreversible Nostr writes. Run them only when the
user explicitly asks to claim or patch that problem. The Notary approval screen
is the final signing boundary. Report the published event ID and accepting
relays. If any operation fails, report the shortest exact error; never guess an
ID, revision, owner, relay, claim, or publication result.

Do not publish maintainer kind-31971 revisions. Do not request merits.

## Protocol

Read [protocol.md](references/protocol.md) before changing event construction,
head selection, claim validity, or signer permissions.

## Requirements

- `nak` 0.19 or newer
- Node.js 22 or newer
- workspace dependencies `applesauce-core`, `applesauce-relay`, and
  `applesauce-signers`
- network access to Nostr relays
- Notary or another compatible NIP-46 bunker for writes
