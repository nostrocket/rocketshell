# Governing protocol

Implementation source of truth:

- Repository `NIP1971.md`: kind 31971 revision selection, problem DAG edges,
  kind 1111 workflow tags, and 24-hour best-effort claims.
- NIP-46: <https://github.com/nostr-protocol/nips/blob/master/46.md>
- Notary: <https://github.com/zig-nostr/notary>
- Official macOS installer:
  <https://github.com/zig-nostr/notary/blob/main/scripts/install-macos.sh>
- Applesauce Nostr Connect:
  <https://applesauce.build/signers/nostr-connect.html>

The fixed actionable root comes from
`navigate-problem-tree/src/problem-dag.ts`:

```text
31971:d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075:7cff61a9f7565ed63c1213040fe0f39c7f2ee1dd4fb96a41e95de049a8dcc170
```

## Workflow event

Contributor writes use kind 1111 and exactly one action marker:

```text
["A", "31971:<owner>:<problem-id>", "<relay>"]
["K", "31971"]
["P", "<owner>", "<relay>"]
["a", "31971:<owner>:<problem-id>", "<relay>"]
["e", "<selected-current-revision-id>", "<relay>", "<revision-author>"]
["k", "31971"]
["p", "<revision-author>", "<relay>"]
["claim"] or ["patched"]
```

Patch proof is event content. No private tag or local wire convention is added.

## Signing constraints

- Pair from a Notary-issued `bunker://` URI over its declared relays.
- Persist the Applesauce `nbunksec` session with mode 0600.
- Request only signing permission for kind 1111.
- Call `get_public_key` and require signed-event pubkey equality.
- After signing, require unchanged kind, timestamp, tags, and content; verify ID
  and signature before publication.
- Publish to the actor's NIP-65 write relays and tagged recipients' read relays,
  falling back to bootstrap relays when no current relay list can be resolved.

## Claim listing semantics

`claims` derives reporting state; it does not add protocol fields or publish
events. It obtains “my” pubkey only by restoring the paired NIP-46 session and
calling `getPublicKey()`. Missing sessions use the same safe Notary status and
setup guidance as write preflight. The command never calls `signEvent()` or a
workflow publication path.

Load every known claim for every discovered problem coordinate before filtering
to the paired pubkey. For each problem, select the current kind `31971` revision
first. Keep equal-newest-timestamp forks unresolved; never choose by event ID.
Evaluate only exact kind `1111` claim shapes with one matching `A` coordinate,
one matching `a` coordinate, one exact `e` revision, and one bare `claim` marker.

A claim remains attached through later selected revisions while their status
does not change. A selected revision on another branch, or a later status
change, supersedes an unacknowledged claim. A later selected `claimed` revision
acknowledges only the exact event and claimant recorded by
`["claim", "<claim-event-id>", "<claimant>"]`.

All claims expire at `created_at + 86400`. Among currently effective,
unexpired claims, earliest `created_at` wins; equal times use ascending claim
event ID. An `rfm` claim stays a request until a selected `claimed` revision
acknowledges it.

Output labels are local explanations, not NIP-1971 statuses:

- `active`: unexpired winning best-effort claim.
- `acknowledged`: selected `claimed` revision records this claim and claimant.
- `pending`: unexpired `rfm` request awaiting acknowledgement.
- `outcompeted`: another claim wins by time and event-ID ordering.
- `expired`: 24-hour window ended.
- `superseded`: selected revision branch or status no longer preserves claim.
- `unresolved`: no unique selected current revision exists.
- `unreachable`: problem is not reachable from configured Nostrocket root.

## Notary installation

Installation is separate from signing and must be explicitly requested. Current
official binary support is macOS on Apple Silicon. The bundled command downloads
the official installer from reviewed Notary commit
`157e0aae107ca4d3f25ed6f2b6885882b12d70eb`, requires SHA-256
`30a2216c7986905aee4f5c49a4904034217687ad765d6b67fa32d15aba2c77d5`,
then runs it. The upstream installer resolves the latest release, verifies its
published digest when available, installs to `/Applications` or the user's
Applications folder, clears quarantine, and opens Notary.
