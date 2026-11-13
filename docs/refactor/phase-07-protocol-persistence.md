# Phase 07 · Shared protocol and persistence boundaries

## Goal

Separate the PC↔mobile wire contracts from HTTP and filesystem persistence.

## Source of truth

Shared protocol contracts now live in:

- `src/core/contracts/artifact-profile.ts`
- `src/core/contracts/backend-protocol.ts`

Filesystem persistence now lives in:

- `src/infrastructure/persistence/backend-storage.ts`

Legacy paths remain temporary compatibility facades:

- `src/backend/types.ts`
- `src/backend/storage.ts`

## Dependency rule

`core/` must not import from `infrastructure/`, `interfaces/`, HTTP, Ollama or filesystem implementations.

The backend HTTP server and mobile worker consume the same core protocol contract.

## Remote safety authority

A mobile/remote `AiJobResultDocument` is valid only when:

- its schema and metadata are valid;
- its result source is `ai` or `fallback`;
- its result classification is **not** `SAFE_CACHE`.

Therefore a remote worker cannot grant deletion authority. `SAFE_CACHE` remains a deterministic local-core decision.

## Compatibility

The HTTP routes, schema names and persisted file layout are unchanged in this phase.

## Acceptance

1. `npx tsc --noEmit` succeeds on PC and mobile.
2. Existing deterministic safety suites still pass.
3. Backend health and authentication behavior are unchanged.
4. Mobile worker can fetch a job and post a result.
5. The E2E suite completes PC → mobile → PC.
6. No remote result accepted by the backend contains `SAFE_CACHE`.
