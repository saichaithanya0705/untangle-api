# Roadmap

Untangle API already has a meaningful gateway baseline. The remaining roadmap is about operational depth, provider conformance, and packaging polish rather than inventing a product from scratch.

## Current baseline

- OpenAI-compatible multi-provider gateway with chat, responses, embeddings, audio, image, and model endpoints.
- Provider routing, fallback, rollout controls, traffic shaping, and cache hooks.
- Control-plane foundation with virtual keys, limits, usage, pricing, reconciliation, and declarative admin operations.
- Bundled admin UI and CLI package.

## Near-term priorities

1. Expand provider-conformance coverage and compatibility fixtures for provider-specific edge cases.
2. Tighten deployment documentation for reverse proxies, TLS termination, and production auth posture.
3. Strengthen persisted control-plane migration and recovery guidance for Postgres and Redis-backed deployments.
4. Continue reducing packaging and operational footguns in the public CLI release path.

## Later priorities

1. Additional secrets-manager integrations.
2. Stronger multi-region operational playbooks.
3. More advanced cache and policy controls where they can be backed by tests and documentation.
