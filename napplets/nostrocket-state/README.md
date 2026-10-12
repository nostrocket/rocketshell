# NOSTROCKET State napplet

Read-only static napplet for kind `31108` rocket state, with NOSTROCKET selected by default and other discovered rockets available in a dropdown. Kind `1409` requests matching the selected rocket are shown as pending when their IDs are absent from state merit lots. Holder and requester names come from NIP-01 kind `0` metadata through OUTBOX routing. Profile pictures load through required NAP-RESOURCE capability; missing or invalid images retain deterministic generated avatars. Merit distribution uses the same integer aggregation as the expandable holder ledger.

The napplet advertises the `napplet:rocket/open` convention (archetype `rocket`) so another napplet can open a specific rocket's ledger through NAP-INTENT. The dispatch payload is `{ coordinate: "31108:<author pubkey>:<identifier>" }`; the picker follows the requested rocket even when discovery has not seen it yet.

The complete fetched reference event is checked in at `src/fixtures/nostrocket-state.json`. Event ID: `2aff6b8c5e9560dbe6cab403c0a3eea478ddfe06f1361dfb05fa582a0dddb207`. Tests use this fixture; production runtime never renders it as fallback data.

Protocol references:

- NAP-OUTBOX: https://github.com/napplet/naps/blob/master/naps/NAP-OUTBOX.md
- NIP-66: https://github.com/nostr-protocol/nips/blob/master/66.md
- Nostrocket kind 31108: https://github.com/nostrocket/NIPS/blob/main/31108.md
- Ruleset 334000: https://github.com/nostrocket/NIPS/blob/main/MSBR334000.md

Commands: `pnpm verify`, `pnpm test:conformance`.
