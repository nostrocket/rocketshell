# Design: Problem Composer

## Mode

Operate. Two write modes share one document and one window:
`napplet:composer/problem-child` (genesis) and
`napplet:composer/problem-edit` (revision). The mode is chosen from the intent
the shell delivers; `src/main.ts` is the router and switches modes in place.

## Visual worlds

- **Compose** — field incident sheet: cool white work surface, deep ink
  structure, signal orange reserved for inherited parent context and decisive
  states. Full-width, title and description dominate, one disclosure, one
  bottom action rail.
- **Revise** — reading-room editor: neutral paper, one electric action color,
  rounded fields, direct-parent ledger, one publish action.

Both are single column at every size and stay functional down to 280 CSS pixels.
Every mode stylesheet is scoped under its wrapper class
(`.mode-compose` / `.mode-revise`), and each mode owns a namespaced custom
property set, so the two palettes never collide in one bundle.

## Interaction

- Routed intent replaces the current mode without reloading; the window is
  reused, not stacked.
- Validation stays beside the affected input and in one live status region.
- GSAP supplies short entrance and disclosure transitions; reduced-motion mode
  removes them.
- Revise mode applies NAP-THEME to its own container when available and keeps a
  readable fallback palette otherwise.

## Responsive behavior

- Compose: inline field groups stack below 620px; the sticky action rail becomes
  ordinary flow where it would obstruct.
- Revise: controls stack below 680px and remain usable at 320px.

## Architecture

```
src/
  main.ts            router: intent conventions -> mode -> one window
  context.ts         AppContext (root, identity read + change notification)
  problem.ts         shared NIP-1971 primitives (tags, heads, ancestors, graph)
  compose.ts         genesis template builder + parent resolution
  revise.ts          revision template builder + ancestry changes
  compose-view.ts    genesis mode UI
  revise-view.ts     revision mode UI
  parent-editor.ts   direct-parent ledger (revise)
  editor-access.ts   identity-driven access state (revise)
  editor-state.ts    field collection/reset (compose)
  editor-host.ts     shared Markdown editor mount + NAP-UPLOAD helper
  attachment.ts, publish-result.ts
  styles.css         scoped mode stylesheets
```
