# Problem Composer

One packaged napplet that owns both NIP-1971 write conventions. It replaces the
former `log-new-problem` and `edit-problem` napplets, which were the same job
(edit a kind-31971 draft and publish it) with different templates.

## Platform

web

## Users

Technical maintainers and general community members who record a new problem or
revise an existing one, publishing through the shell without handling keys,
relays, or uploads directly.

## Product Purpose

Create a graph-root or child problem (`napplet:composer/problem-child`), or
publish the next complete revision of an existing problem
(`napplet:composer/problem-edit`), through shell-owned capabilities.

## Intent surface

- Archetype `composer`; conventions `napplet:composer/problem-child` and
  `napplet:composer/problem-edit`. Both are project-local conventions, not NAP or
  NAAT standards. Neither payload declares an owner: the shell attests the
  sender, and identity comes from NAP-IDENTITY.
- Payload is exactly `{ "problemId": "<64 lowercase hex>" }` for both. The child
  convention also accepts delivery with no payload, which opens a root composer.
- The manifest advertises one `composer` slug with two conventions. NAP-INTENT is
  N:M, so the shell routes either convention to this dTag and reuses one window;
  `src/main.ts` picks the mode from the delivered convention.

## Modes

- **Compose (genesis)** — root or child problem. Title and Markdown description
  first; advanced protocol detail behind one disclosure. Child mode resolves the
  parent, its graph root, and every ancestor owner through NAP-OUTBOX, then
  publishes a genesis template carrying owner and ancestor maintainers.
- **Revise (revision)** — loads the selected current head and the whole graph,
  edits title/description/status, allows authorized editors to change direct
  parents, and publishes a complete revision preserving graph identity and
  lineage. After confirmation it dispatches `napplet:note/open` so the problem
  viewer returns with the new revision.

## Capabilities and Constraints

- Reads and publishes only through NAP-OUTBOX; identity through NAP-IDENTITY;
  intent delivery through NAP-INC after shell archetype routing; media through
  NAP-UPLOAD. NAP-THEME is optional and used by revise mode only.
- Independently buildable single-file packaged napplet using public napplet SDK
  contracts. No shell imports, ambient network, browser storage, signer, relay
  pool, or EventStore.
- Native form submission is forbidden by the `allow-scripts` sandbox; every
  control is scripted and Ctrl/Cmd+Enter is handled explicitly.
- `napplet-conformance` passes with only the unconditional checks (manifest,
  wire, and lifecycle checks skip because no signed NIP-5D manifest event is
  resolved for a local build).

## Evidence on Hand

- Local `NIP-1971` draft defines problem and workflow events.
- Living NAP specifications define web projection and shell capabilities.
- Living NAP-INTENT defines archetype/convention independence (N:M).

## Product Principles

- Problem truth first; protocol detail only on demand.
- Every publish state names progress, failure, and recovery.
- Ancestry changes are validated against loaded graph data before publishing.
- Keyboard accessible, narrow-iframe responsive, reduced-motion safe.
