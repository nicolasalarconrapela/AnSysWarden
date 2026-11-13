# Phase 08 · Interface placement and legacy cleanup

## Goal

Place runtime interfaces in their final architectural layer and stop new code/tests from depending on compatibility paths created during phases 05–07.

## Final interface locations

```text
src/interfaces/
├── cli/
├── http/
│   └── server.ts
└── worker/
    └── mobile-worker.ts
```

`src/backend/server.ts` and `src/worker/mobile-worker.ts` remain temporary compatibility entrypoints so the existing `./ansys` command surface does not change during the refactor.

## Updated direct consumers

The following now consume final boundaries directly:

- CLI commands -> application / infrastructure / presentation
- HTTP backend -> `core/contracts` + `infrastructure/persistence`
- mobile worker -> `core/contracts` + `infrastructure/ollama`
- AI safety tests -> `core/classification`, `core/contracts`, `infrastructure/ollama`
- deterministic rule tests -> `core/classification`
- overlap tests -> `application/scan`
- model comparison runner -> `core/classification` + `infrastructure/ollama`
- cache benchmark runner -> `core/classification` + `infrastructure/ollama`

## Compatibility paths retained temporarily

These paths are deprecated for new code but are intentionally retained until TypeScript and PC/mobile regression validation pass:

```text
src/ai/types.ts
src/ai/rules.ts
src/ai/ollama-client.ts
src/backend/types.ts
src/backend/storage.ts
src/backend/server.ts
src/profiler/artifact-profiler.ts
src/scanner/scanner.ts
src/worker/mobile-worker.ts
```

Some datasets or secondary tools may still reference a compatibility type-only facade. They must be migrated before the corresponding facade is deleted.

## Safety invariant

No interface relocation may change authority:

```text
Gemma/mobile worker -> evidence / USER_DATA / REVIEW_REQUIRED
PC deterministic core -> only authority that may grant SAFE_CACHE
human -> final destructive approval
```

Remote `AiJobResultDocument` validation continues to reject `SAFE_CACHE`.

## Removal gate

A compatibility facade may be deleted only after:

1. `npx tsc --noEmit` passes on PC.
2. `npx tsc --noEmit` passes on mobile.
3. deterministic rule/overlap/tree/context/candidate tests pass.
4. AI safety suite passes its system guardrails.
5. PC -> mobile -> PC E2E completes with zero remote `SAFE_CACHE` results.

Until that gate is satisfied, compatibility files are cheap insurance and should remain tiny re-export/entrypoint files rather than duplicated implementations.
