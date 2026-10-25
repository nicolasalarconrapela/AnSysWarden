import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiTreePruner } from '../ai/tree-pruner';
import { SCAN_SCHEMA, type ScanDocument } from '../backend/types';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ansyswarden-candidates-'));

  try {
    const rust = join(root, 'rust-app');
    const unknown = join(root, 'mystery-cache');
    await mkdir(join(rust, 'src'), { recursive: true });
    await mkdir(join(rust, 'target'), { recursive: true });
    await mkdir(unknown, { recursive: true });
    await writeFile(join(rust, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    await writeFile(join(rust, 'Cargo.lock'), '# lock\n');
    await writeFile(join(unknown, 'blob.dat'), 'x');

    const scan: ScanDocument = {
      schema: SCAN_SCHEMA,
      id: 'candidate-test',
      createdAt: new Date().toISOString(),
      source: 'test',
      computer: 'test',
      entries: [
        { entryId: 'root', path: root, sizeBytes: 500_000_000, depth: 0 },
        { entryId: 'rust', parentId: 'root', path: rust, sizeBytes: 200_000_000, depth: 1 },
        { entryId: 'mystery', parentId: 'root', path: unknown, sizeBytes: 300_000_000, depth: 1 },
      ],
    };

    const result = await new AiTreePruner().build(scan, root, { maxDepth: 6, maxEntries: 2000 });
    const paths = new Set(result.candidates.map((item) => item.path));

    const checks = [
      {
        name: 'directorio grande desconocido de primer nivel llega a Gemma',
        ok: paths.has(unknown),
      },
      {
        name: 'raíz de proyecto Rust no se propone completa a Gemma',
        ok: !paths.has(rust),
      },
      {
        name: 'raíz global del scan nunca se propone a Gemma',
        ok: !paths.has(root),
      },
      {
        name: 'candidato incluye razón explicativa',
        ok: result.candidates.find((item) => item.path === unknown)?.reason.length > 0,
      },
    ];

    let failed = 0;
    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
      if (!check.ok) failed += 1;
    }

    if (failed > 0) {
      console.error(`\nFAIL: ${failed} comprobación(es) de candidatos incorrectas.`);
      process.exitCode = 1;
    } else {
      console.log(`\nPASS: ${checks.length} comprobaciones de candidatos correctas.`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Candidate Test] ${message}`);
  process.exitCode = 1;
});
