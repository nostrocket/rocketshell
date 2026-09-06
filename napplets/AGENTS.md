# Napplet implementation rules

## Nostrocket contributor workflow

- For requests to find actionable work in the Nostrocket DAG, inspect a
  problem, list its children, claim a problem, or publish solution proof,
  activate and follow the installed `nostrocket` skill.
- Use `nostrocket actionable` for open leaves. It starts from the configured
  project root; never ask the user for a root problem ID.
- Treat `actionable`, `inspect`, and `children` as read-only discovery. Inspect
  a selected problem before asking to claim it.
- Treat `claim` and `patch` as public, irreversible Nostr writes. Run either
  only after an explicit user request, and report the published event ID and
  accepting relays.
- Claims require a paired Notary NIP-46 signer. Never install Notary
  implicitly; run `install-notary` only when the user explicitly requests the
  installation. Never expose a `bunker://` URI, `nbunksec` value, or stored
  signer session.
- This workflow is contributor-only. Do not publish maintainer revisions or
  request merits through the `nostrocket` skill.

## Visual style

- Always follow the established visual style of the existing built-in napplets.
- Before designing or changing a napplet UI, inspect relevant built-in napplets
  and reuse their established layout, typography, spacing, colors, controls, and
  interaction patterns unless the user explicitly requests a different style.

## Error handling

- Never silently swallow an exception. Every `catch` must bind the original
  error and then do at least one of: show a useful error to the user, report it
  with `console.error` or `console.warn` plus operation-specific context, or
  rethrow it.
- Fallback behavior is allowed only after the original failure is reported.
  Do not use empty `catch` blocks, `catch { ... }`, or context-free forms such
  as `.catch(() => fallback)`.
- Error reports must identify the failed operation and include safe identifiers
  needed to diagnose it. Do not log secrets, decrypted content, private keys,
  authorization material, or full sensitive payloads.
- Preserve graceful degradation for optional capabilities, but make the reason
  observable to developers and, when it affects the requested user action,
  visible in the napplet UI.

## Intent navigation

- Open another napplet through the public intent contract using its archetype and
  payload. Do not name a specific handler unless the user explicitly selected one
  or the living NAP specification requires it.
- Napplet-to-napplet navigation must not ask for per-invocation authorization or
  display an "Allow?" confirmation. Handler discovery, validation, defaults, and
  routing policy belong to the shell.
- Test every cross-napplet open inside the packaged sandbox. It must open through
  intent routing without a browser confirmation. If a confirmation appears, fix
  shell intent policy or the sender's unnecessary explicit-handler request; do not
  add a napplet-local workaround.
- Treat dispatch and focus as separate behavior. A user request to open or update
  another napplet does not imply permission to replace the caller's surface.
- In this shell, `behavior.focus: true` moves the target into the caller's layout
  slot and hides the caller. For navigation surfaces that update an adjacent or
  already-visible peer, use `{ focus: false, reuse: true }` unless the user
  explicitly requests replacement navigation.
- Before changing `focus`, `reuse`, or `newWindow`, inspect the current living
  NAP-INTENT specification and host window-manager semantics. Do not infer these
  flags from their names.
- Cross-napplet regression tests must invoke the production dispatch helper and
  assert the actual intent payload and behavior options. A test that only compares
  an exported constant is insufficient.
- For adjacent-peer navigation, test with caller and target both visible. Assert
  that activation updates the reused target while both surfaces remain visible;
  keep the host window-manager visibility test green alongside napplet tests.
- Refresh is part of every window-placement regression. Preserve caller/target
  ordering and stored grid coordinates across session persistence and restore;
  a passing pre-refresh interaction alone is insufficient.

## Sandboxed form controls

- Web napplets run in `sandbox="allow-scripts"` iframes. Do not add or depend on
  `allow-forms`; keep runtime sandbox permissions aligned with the living NAP web
  projection.
- Do not use native form submission in napplets. A `<form>` submission is blocked
  by the sandbox even when application code intends to intercept it.
- Implement submit-like interactions with `type="button"` controls and scripted
  event handlers. Preserve keyboard behavior explicitly, including handling Enter
  where users expect it, and call `preventDefault()` for that key event.
- When testing a new napplet, exercise both pointer activation and Enter-key
  activation inside the sandboxed runtime and confirm neither attempts navigation
  nor logs an `allow-forms` browser error.
