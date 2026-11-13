# Refactor · Phase 01 — Presentation boundary

## Goal

Separate human-facing terminal presentation from application and safety logic without changing behavior.

This phase is intentionally conservative. It must not change classification rules, AI authority, backend contracts, worker behavior, or deletion policy.

## Problem being addressed

`src/cli.ts` currently mixes several responsibilities:

- command orchestration,
- calls to Ollama and classifiers,
- scanner execution,
- safety-suite coordination,
- ANSI colors,
- translated labels,
- banners and separators,
- terminal formatting.

That makes architectural, code, and visual complexity grow together.

## Target boundary

```text
application / safety result
          |
          v
interfaces/cli/presentation
          |
          v
terminal output
```

Presentation may format and translate data, but it must never decide whether a path is `SAFE_CACHE`, `REVIEW_REQUIRED`, or `USER_DATA`.

## Phase 01 structure

```text
src/interfaces/cli/presentation/
├── terminal.ts
├── classification-presenter.ts
├── scan-presenter.ts
└── safety-presenter.ts      # later step in this phase
```

## Rules

1. No classification rule changes.
2. No Ollama policy changes.
3. No backend/API schema changes.
4. No worker protocol changes.
5. No deletion capability added.
6. Existing English/Spanish behavior must remain available.
7. `NO_COLOR` behavior must remain supported.
8. Machine-readable identifiers are never translated.

## Acceptance criteria

PC and mobile must both pass:

```bash
bash -n ./ansys
npx tsc --noEmit
./ansys test rules
./ansys test overlap
./ansys test tree
./ansys test context
./ansys test candidates
```

Mobile additionally verifies:

```bash
./ansys ai status
./ansys ai test
```

The final cross-device gate remains:

```text
PC -> mobile worker -> Gemma -> PC
remote SAFE_CACHE = 0
```

## Definition of done

Phase 01 is complete when `src/cli.ts` no longer owns terminal styling or large output-formatting blocks and instead delegates presentation to modules under `src/interfaces/cli/presentation/`, while all previous tests still pass.
