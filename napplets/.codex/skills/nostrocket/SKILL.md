---
name: nostrocket
description: Find actionable NIP-1971 problems and inspect, list, claim, or patch problems in the Nostrocket DAG. Use for available work, open leaves, problem children, problem status, contributor claims, and solution proof publication. Contributor-only; excludes maintainer revisions and merit requests.
---

# Nostrocket

Use the bundled command from any directory. Resolve paths relative to this file.

```bash
bash scripts/nostrocket.sh actionable
bash scripts/nostrocket.sh inspect '<problem-id>'
bash scripts/nostrocket.sh children '<problem-id>'
bash scripts/nostrocket.sh claim '<problem-id>'
bash scripts/nostrocket.sh patch '<problem-id>' --proof '<https-url>'
```

`actionable` always starts at the project root compiled into the command. Never
ask for a root ID. “Open leaves” means `actionable`.

Before the first write, pair the agent with Notary:

```bash
bash scripts/nostrocket.sh connect
```

Paste the `bunker://` URI at the hidden prompt. The command requests only
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
