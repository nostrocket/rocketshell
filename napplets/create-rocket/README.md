# Create Rocket

Creates a Sovereign Economic Community ignition event under Nostrocket MSB ruleset `334000`. User reviews exact unsigned template before shell-mediated signing and OUTBOX-first publication.

Problem references are selected from kind `31971` events reachable beneath same hardcoded NOSTROCKET root used by problem DAG viewer. Choices render in root-to-leaf order with visible nesting; disconnected events sharing query results are excluded. Repository references remain limited to current signer's kind `30617` NIP-34 repository announcements. Coordinates and relay hints come from validated events and shell-owned OUTBOX routing; users never enter protocol coordinates.

NOSTROCKET ignition event is preserved verbatim in `src/fixtures/nostrocket-ignition.json` as test fixture and structural reference. It adds no protocol link to newly created rockets because governing specs define no cross-rocket reference tag.

Required tags: `d`, `ruleset`, `ignition`, and `parent`. Optional ruleset tags use specified `mission`, `image`, `problem`, and `repo` forms.

The optional `image` tag carries a rocket's logo. The URL is read through the shell `resource` domain and the sha256 digest of the exact bytes is published beside it (`["image", <url>, <sha256>]`), so a reader can verify the bytes it renders instead of trusting a mutable URL. When the domain is unavailable the URL is still published without a digest, and when the URL changes any previously computed digest is discarded rather than republished against different bytes.

Sources: [NIP 31108](https://github.com/nostrocket/NIPS/blob/main/31108.md), [MSBR334000](https://github.com/nostrocket/NIPS/blob/main/MSBR334000.md), and [living NAP specifications](https://github.com/napplet/naps).

```sh
pnpm verify
pnpm test:conformance
```
