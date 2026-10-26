# Phase 06 — Filesystem and Dust boundaries

## Goal

Separate physical filesystem/process access from application orchestration without changing AnSysWarden behavior or safety authority.

## New boundaries

### Infrastructure

- `src/infrastructure/filesystem/artifact-profiler.ts`
  - owns local filesystem profiling
  - uses `fs/promises`
  - returns normalized `ArtifactProfile`

- `src/infrastructure/filesystem/directory-measurer.ts`
  - walks directories
  - measures directory sizes
  - counts files/directories/skipped entries
  - never classifies or authorizes deletion

- `src/infrastructure/dust/dust-adapter.ts`
  - resolves and executes the external Dust binary
  - limits captured output
  - parses Dust JSON
  - normalizes entries
  - does not persist scans or make safety decisions

### Application

- `src/application/scan/scan-service.ts`
  - selects measured candidate directories
  - asks `PathClassifier` to classify candidates
  - calculates recoverable bytes conservatively
  - applies overlap safety policy
  - does not read the filesystem directly

## Compatibility facades

The following legacy import paths remain temporarily available:

- `src/profiler/artifact-profiler.ts`
- `src/scanner/scanner.ts`

They re-export the new implementations so older tests/callers can migrate gradually.

## Dust orchestration

`src/dust/dust-scanner.ts` remains an orchestration layer for now. It delegates external-process execution and JSON parsing to `DustAdapter`, then persists the resulting scan and builds AI input.

Moving persistence/backend concerns out of this class is intentionally deferred to the next phase.

## Safety invariants

This phase must not change:

- only deterministic local rules may authorize `SAFE_CACHE`;
- AI evidence cannot authorize `SAFE_CACHE`;
- symlinks remain skipped;
- inaccessible filesystem entries degrade conservatively;
- recoverable byte totals remain overlap-safe;
- Dust runs directory-only mode (`-D`) so isolated large files do not become deletion candidates.

## Acceptance

- TypeScript compiles.
- Deterministic rule tests pass.
- Scanner overlap tests pass.
- Tree/context/candidate tests pass.
- Dust status/scan behavior remains compatible where Dust is installed.
- Mobile AI status/test/safety behavior remains unchanged.
