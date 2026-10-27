# Phase 03 — Safety command boundary

## Goal

Separate the AI safety command into orchestration and presentation without changing the effective safety policy.

## New boundaries

```text
src/tests/ai-safety.ts
  -> safety engine / test execution

src/interfaces/cli/commands/safety-command.ts
  -> orchestration / precheck / exit codes

src/interfaces/cli/presentation/safety-presenter.ts
  -> terminal rendering / human-readable output
```

## Safety invariant

This phase must not change the authorization model:

- deterministic local rules may authorize `SAFE_CACHE`;
- Gemma / remote AI evidence may never authorize effective `SAFE_CACHE`;
- invalid or failed AI analysis must remain conservative;
- the current CLI remains read-only.

## Acceptance

Before closing the phase:

```bash
bash -n ./ansys
npx tsc --noEmit
./ansys test rules
./ansys test overlap
./ansys test safety
```

The refactor is accepted only if behavior and safety results remain equivalent to the pre-refactor baseline.
