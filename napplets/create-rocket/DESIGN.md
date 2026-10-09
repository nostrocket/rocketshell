# Create Rocket design

- Deployment/d-tag: `create-rocket`
- New, independently built static napplet
- Job: validate, preview, and publish one ruleset `334000` ignition event
- Required shell domains: `outbox`, `identity`, `resource`; optional enhancement: `theme`
- Shell owns signing, author identity, relay routing, and publication
- No direct network, storage, relay escape hatch, external assets, backend, or invented protocol field
- Image bytes are read through the shell `resource` domain so the published `image` tag can carry the sha256 digest of what was actually hashed; an absent domain publishes the URL without a digest instead of failing
- Responsive worksheet; problems reachable from hardcoded NOSTROCKET root render root-to-leaf with nesting, while user-owned repositories render as a selectable list
- Pointer and Enter activation both preview; publication requires separate explicit confirmation
