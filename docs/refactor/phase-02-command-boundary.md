# Phase 02 · CLI command boundary

## Goal

Reduce code complexity in `src/cli.ts` by moving command orchestration into dedicated command modules while preserving behavior and safety contracts.

## Scope

Phase 02 starts by extracting:

- `doctor`
- `classify`
- `scan`

into:

```text
src/interfaces/cli/commands/
```

The CLI entrypoint should progressively become a thin router.

## Dependency direction

```text
src/cli.ts
  ↓
interfaces/cli/commands
  ↓
AI / scanner / infrastructure
  ↓
interfaces/cli/presentation
```

Commands may coordinate dependencies, but presentation must stay in presenters.

## Out of scope

This phase does not:

- change deterministic safety rules;
- change `SAFE_CACHE`, `REVIEW_REQUIRED`, or `USER_DATA` semantics;
- change Ollama prompts or inference policy;
- change backend contracts;
- enable deletion;
- redesign the frontend.

## Acceptance criteria

Before closing Phase 02:

1. `src/cli.ts` routes `doctor`, `classify`, and `scan` through command modules.
2. Existing CLI output remains equivalent for those commands.
3. `bash -n ./ansys` passes.
4. `npx tsc --noEmit` passes.
5. deterministic test suites still pass.
6. PC and mobile AI smoke tests keep working.
7. remote AI still has zero authority to authorize `SAFE_CACHE`.

## Next extraction

The safety suite is intentionally left for a separate cut because it mixes orchestration, human explanation, technical trace rendering, and model prechecks. It will be split after the small commands are stable.
