# Phase 05 · Core vs infrastructure

## Goal

Make the architectural boundary explicit between deterministic AnSysWarden domain logic and external adapters.

## Core

`src/core/` contains domain contracts and deterministic policy. Core must not depend on Ollama, HTTP, filesystem traversal, Dust, terminal output, or frontend code.

Current classification core:

```text
src/core/classification/
├── types.ts
└── rules.ts
```

The core owns the effective classification vocabulary and the deterministic rules that may authorize `SAFE_CACHE`.

## Infrastructure

`src/infrastructure/` contains adapters to external systems.

Current adapter:

```text
src/infrastructure/ollama/
└── ollama-client.ts
```

Ollama may provide evidence, but it does not own effective classification authority.

## Compatibility facades

During migration, these files remain as temporary compatibility facades:

```text
src/ai/types.ts
src/ai/rules.ts
src/ai/ollama-client.ts
```

New code should prefer the new `core/` and `infrastructure/` paths. The compatibility facades can be removed only after all callers have migrated and regression tests pass.

## Safety invariant

The refactor does not change the security model:

- deterministic local rules may authorize `SAFE_CACHE`;
- AI evidence may protect as `USER_DATA` or require `REVIEW_REQUIRED`;
- AI must never directly authorize effective `SAFE_CACHE`;
- invalid or unavailable AI degrades safely to human review.

## Acceptance criteria

- TypeScript compiles without errors.
- Deterministic rule tests remain unchanged in behavior.
- Ollama health and inference tests still work on mobile.
- Safety suite preserves the same effective classifications.
- E2E PC → mobile → PC still rejects remote `SAFE_CACHE`.
