# Phase 04 — Thin CLI router

## Goal

Reduce `src/cli.ts` to a thin command router.

The root TypeScript CLI must no longer own:

- classification logic,
- scan orchestration,
- Ollama prechecks,
- AI safety rendering,
- ANSI presentation helpers,
- scan/result formatting.

Those responsibilities now live under `src/interfaces/cli/commands/` and `src/interfaces/cli/presentation/`.

## Resulting dependency direction

```text
src/cli.ts
  -> interfaces/cli/commands
      -> application/infrastructure modules
      -> interfaces/cli/presentation
```

## Safety invariants

This refactor must not change:

- the `SAFE_CACHE` authority boundary,
- deterministic rule precedence,
- AI fallback behavior,
- safety test semantics,
- read-only behavior,
- machine-readable classification values.

## Acceptance checks

```bash
bash -n ./ansys
npx tsc --noEmit
./ansys doctor
./ansys test rules
./ansys test overlap
./ansys test tree
./ansys test context
./ansys test candidates
./ansys test safety
```

On the mobile device also verify:

```bash
./ansys ai status
./ansys ai test
./ansys test safety
```

A pass means behavior remains equivalent while `src/cli.ts` is limited to routing, top-level logging and fatal-error handling.
