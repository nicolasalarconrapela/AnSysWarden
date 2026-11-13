import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiTreePruner } from '../ai/tree-pruner';
import { SCAN_SCHEMA, type ScanDocument } from '../backend/types';
import { getLanguage } from '../i18n';

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

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
    const unknownCandidate = result.candidates.find((item) => item.path === unknown);

    const checks = [
      { en: 'unknown large top-level directory reaches Gemma', es: 'un directorio grande desconocido de primer nivel llega a Gemma', ok: paths.has(unknown) },
      { en: 'Rust project root is not proposed wholesale to Gemma', es: 'la raíz de un proyecto Rust no se propone completa a Gemma', ok: !paths.has(rust) },
      { en: 'global scan root is never proposed to Gemma', es: 'la raíz global del escaneo nunca se propone a Gemma', ok: !paths.has(root) },
      { en: 'candidate includes an explanatory reason', es: 'el candidato incluye un motivo explicativo', ok: Boolean(unknownCandidate?.reason && unknownCandidate.reason.length > 0) },
    ];

    let failed = 0;
    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${pick(check.en, check.es)}`);
      if (!check.ok) failed += 1;
    }

    if (failed > 0) {
      console.error(`\nFAIL: ${failed} ${pick('incorrect candidate check(s).', 'comprobación(es) de candidatos incorrecta(s).')}`);
      process.exitCode = 1;
    } else {
      console.log(`\nPASS: ${checks.length} ${pick('candidate checks are correct.', 'comprobaciones de candidatos correctas.')}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden ${pick('Candidate Test', 'Prueba de candidatos')}] ${message}`);
  process.exitCode = 1;
});
