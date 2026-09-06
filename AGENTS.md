# Repository instructions

## UI requirements

- Always keep the user profile/avatar menu as the leftmost item in the menu bar.
  No icon, indicator, status, or other control may appear to its left.
- For UI motion, animation, and transitions, always use GSAP whenever
  technically possible. Prefer GSAP over CSS animations and transitions.
- Treat intent dispatch, window visibility, focus, replacement, and layout as
  separate behaviors. Do not infer one from another or change more than the user
  requested.
- In the current window manager, focusing a target with a caller replaces the
  caller's grid slot and hides the caller. Showing a target preserves all window
  visibility and geometry. Verify this host behavior before choosing intent
  `focus`, `reuse`, or `newWindow` options.
- Window-placement changes require regression coverage with caller and target
  both visible, plus a persistence/restore check proving refresh preserves their
  order, visibility, and grid coordinates. Constant-only assertions and mocked
  dispatch success are not sufficient.

## Configuration requirements

- Do not use environment variables.

## Local skills

- Keep every repository-owned skill documented in the
  [README skill index](README.md#local-agent-skills).
- `applesauce`: [.agents definition](.agents/skills/applesauce/SKILL.md).
- `build-napplet`: [.codex definition](.codex/skills/build-napplet/SKILL.md),
  [napplets definition](napplets/.codex/skills/build-napplet/SKILL.md).
- `commit-token-cost`:
  [napplets definition](napplets/.codex/skills/commit-token-cost/SKILL.md).
- `design-napplet`: [.codex definition](.codex/skills/design-napplet/SKILL.md),
  [napplets definition](napplets/.codex/skills/design-napplet/SKILL.md).
- `make-napplet`: [.codex definition](.codex/skills/make-napplet/SKILL.md),
  [napplets definition](napplets/.codex/skills/make-napplet/SKILL.md).
- `nostrocket`: [napplets definition](napplets/.codex/skills/nostrocket/SKILL.md).
- `port-nostr-app`: [.codex definition](.codex/skills/port-nostr-app/SKILL.md),
  [napplets definition](napplets/.codex/skills/port-nostr-app/SKILL.md).
- `test-napplet`: [.codex definition](.codex/skills/test-napplet/SKILL.md),
  [napplets definition](napplets/.codex/skills/test-napplet/SKILL.md).

## Crush Bugs opt-in only

- Do not activate, invoke, inspect, or follow the installed `crush-bugs` skill
  unless the user explicitly requests `crush-bugs` in the current message.
- A general request to find, diagnose, review, or fix problems is not permission
  to use `crush-bugs`. Prior use does not carry forward to later messages.

## Deployment requirements

- No backend is permitted in this project. Do not add or depend on servers,
  server-side APIs, serverless functions, backend proxies, native host services,
  or other non-browser execution environments. Keep the shell and all napplets
  independently deployable as static browser assets.

## Shell and packaged napplet boundary

- Treat packaged napplets and the shell as separate products with a strict
  host/application boundary.
- For any task involving napplets, first check the living NAP specifications at
  `https://github.com/napplet/naps` for relevant requirements and examples.
  Base napplet design, implementation, and protocol decisions on those current
  references rather than memory, local conventions, or invented patterns.
- For protocol audits, identify and read the current governing specification
  before evaluating implementation details. Treat referenced specifications as
  dependencies only: apply their rules solely where the governing specification
  explicitly incorporates them. When summaries, linked documents, current text,
  or revision history conflict, resolve the conflict against the latest living
  governing text and its relevant revisions before reporting any finding. Never
  infer that adopting another specification's fields, tags, algorithms, or
  structure also adopts its event kinds, identifier limits, or unrelated rules.
- Never invent or present new Napplet, Nostr, NIP, NAP, manifest, event-tag, or
  wire-format conventions as standards. Every protocol field and tag shape must
  have a cited authoritative specification. If no standard exists, say so and
  use an existing standards-aligned mechanism; do not create an ad hoc field
  such as `["icon", "https://example.com/icon.png"]`.
- This prohibition also covers host-only and implementation-internal values
  that change protocol meaning: permission or grant tokens, wildcard and
  scheme-wide matching, capability semantics, policy identifiers, fallback
  conventions, and interpretations of public API fields. Before implementing
  any such value or behavior, cite the current governing specification or the
  public API documentation that defines its exact syntax and semantics. An
  internal detail is not exempt when it affects what a napplet may request or
  what the shell accepts. If no authoritative mechanism supports the required
  behavior, stop that implementation, report the standards gap, and propose an
  upstream specification or public-API change. Never create a local convention
  as a compatibility shortcut.
- Packaged napplet code belongs under `napplets/<napplet>/`. It must remain
  independently buildable and deployable, and may depend only on public
  napplet SDKs and platform contracts. It must not import shell source, host
  services, adapters, the Nostr engine, shell state, or shell-only UI assets.
- Shell and host implementation belongs under `apps/shell/` and `packages/`.
  It may discover, load, sandbox, and provide declared capabilities to
  napplets, but must not contain napplet-specific application behavior or
  reach into a napplet's internal modules.
- All communication across this boundary must use the public napplet manifest,
  gateway, and platform contract. Do not bypass that contract with workspace
  imports, shared mutable state, DOM access across the boundary, or private
  implementation APIs.
- Before changing code, classify the change as shell-owned, contract-owned, or
  napplet-owned and keep implementation and tests on that side. If both sides
  must change, separate the changes and preserve dependency direction from
  napplet to public contract, never to shell implementation.

## Applesauce requirements

- For any task involving Applesauce, always activate and follow the installed
  `applesauce` skill.
- For any task involving Applesauce, always use the `applesauce` MCP server at
  `https://mcp.applesauce.build/mcp` for documentation, API, and example
  discovery.
- Never design, implement, modify, or generate Applesauce-related code before
  examining relevant real Applesauce examples through the Applesauce MCP
  server. Base work on those examples and current Applesauce APIs rather than
  memory or invented patterns.
- Always use functional programming for Applesauce-related code. Never use
  object-oriented programming, including classes, inheritance, or
  object-oriented design patterns, for anything related to Applesauce.
- Never create more than one Applesauce `EventStore`. All Applesauce-related
  code must share one application-wide `EventStore` instance.
- If the Applesauce skill or MCP server is unavailable, stop Applesauce
  implementation and report the blocker instead of building from assumptions.

## Commits

- Before committing, run every test suite and check defined by CI and require all
  of them to pass. Never create a commit with a known CI test or check failure.
- Commit every completed change before handing work back to user.
- Keep each commit focused on one logical change.
- Write every commit message as a problem statement using this subject format:
  `problem: <affected subject> <undesirable condition or missing capability>`.
- Keep commit subjects under 50 characters when practical and never over 70
  characters.
- Describe the problem solved, not the solution, implementation, command, or
  files changed. Add a wrapped body only when needed for rationale, breaking
  changes, migrations, reverts, or issue references.
- Include API-equivalent cost estimates in every final commit message using
  these body trailers; keep them out of the subject:

  ```text
  Cost-USD: $<amount>
  Cost-BTC: <integer> sats
  ```

- Produce cost trailers by explicitly invoking the repository
  `$commit-token-cost` skill. Create
  the commit after all required checks pass, calculate its estimate, then amend
  only its message to add the trailers. Treat values as estimates for the
  pre-amend commit because calculating them requires an existing commit. Do not
  finalize or hand off a commit without both trailers.
