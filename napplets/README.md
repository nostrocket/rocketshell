# Napplets

This directory is the complete boundary for napplet-owned material. Runtime,
shell, gateway, and host-service code stays outside it.

- [`AUTHORING-SPEC.md`](AUTHORING-SPEC.md) defines how to create, build, test,
  and publish a napplet.
- [`LOADING-ARCHITECTURE.md`](LOADING-ARCHITECTURE.md) defines how this monorepo
  discovers and loads built-in napplets.
Each direct child containing both `package.json#napplet` and `dist/index.html`
is eligible for built-in discovery. Documentation directories and incomplete
projects are ignored.

## Finding and claiming DAG work

Use the installed `nostrocket` skill for contributor work on the Nostrocket
DAG. From an agent prompt, `$nostrocket actionable` lists reachable open leaves
that have no current children, effective claim, or unresolved current-head
fork. No root problem ID is needed.

Review a candidate before claiming it:

```text
$nostrocket actionable
$nostrocket inspect <problem-id>
$nostrocket claim <problem-id>
```

`actionable` and `inspect` are read-only. `claim` publishes a public,
irreversible kind-1111 Nostr event and requires approval through a paired Notary
NIP-46 signer. If Notary is absent, request installation explicitly with
`$nostrocket install-notary`; claiming never installs it automatically. Keep
`bunker://` URIs, `nbunksec` values, and stored signer sessions secret.

After a successful claim, record the published event ID and accepting relays.
The skill supports contributor claims and solution proofs only; it does not
publish maintainer revisions or request merits.

## Problem tracker media

Problem descriptions may contain direct Markdown media references:

```markdown
![Screenshot](https://blossom.example/<hash>)
```

`log-new-problem` and `edit-problem` require shell-owned NAP-UPLOAD, upload
selected images or videos, and insert returned HTTPS URLs at textarea selection.
Shell rejects these composers before load when upload capability is unavailable.

`view-problem` resolves each Markdown media URL through NAP-RESOURCE rather than
ambient browser networking. It renders content-sniffed images, MP4, and WebM
using temporary blob URLs, reports failures in UI and console, and revokes blob
URLs during rerender and teardown. Current shell media limit is 64 MiB.
