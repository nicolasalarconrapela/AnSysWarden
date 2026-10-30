import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectContextEngine } from '../ai/project-context';
import { decideByEcosystem, detectEcosystems } from '../ai/ecosystem-detector';
import { decideByRepomixPolicy } from '../ai/repomix-policy';
import { getLanguage } from '../i18n';

interface Check {
  nameEn: string;
  nameEs: string;
  ok: boolean;
  detail: string;
}

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ansyswarden-context-'));
  const checks: Check[] = [];

  try {
    const rust = join(root, 'rust-app');
    await mkdir(join(rust, 'src'), { recursive: true });
    await mkdir(join(rust, 'target'), { recursive: true });
    await mkdir(join(rust, 'generated'), { recursive: true });
    await mkdir(join(rust, 'third_party'), { recursive: true });
    await mkdir(join(rust, 'scratch'), { recursive: true });
    await writeFile(join(rust, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    await writeFile(join(rust, 'Cargo.lock'), '# lock\n');
    await writeFile(join(rust, '.gitignore'), 'scratch/\n');
    await writeFile(join(rust, '.gitattributes'), 'generated/** linguist-generated\nthird_party/** linguist-vendored\n');

    const ecosystems = await detectEcosystems(rust);
    const rustDetection = ecosystems.find((item) => item.ecosystem === 'rust');
    checks.push({
      nameEn: 'detects Rust through Cargo.toml/Cargo.lock',
      nameEs: 'detecta Rust mediante Cargo.toml/Cargo.lock',
      ok: Boolean(rustDetection && rustDetection.confidence >= 0.8),
      detail: JSON.stringify(ecosystems),
    });

    const targetDecision = decideByEcosystem(join(rust, 'target'), true, ecosystems);
    checks.push({
      nameEn: 'target is recognized as build output from Rust context',
      nameEs: 'target se reconoce como salida de build por el contexto Rust',
      ok: targetDecision?.kind === 'BUILD_OUTPUT',
      detail: JSON.stringify(targetDecision),
    });

    const context = new ProjectContextEngine(root);
    const ignored = await context.decide(join(rust, 'scratch'), true);
    checks.push({
      nameEn: 'project .gitignore filters scratch',
      nameEs: 'el .gitignore del proyecto filtra scratch',
      ok: ignored?.kind === 'GIT_IGNORED',
      detail: JSON.stringify(ignored),
    });

    await writeFile(join(rust, 'generated', 'bindings.rs'), '// generated\n');
    await writeFile(join(rust, 'third_party', 'lib.rs'), '// vendor\n');
    const generated = await context.decide(join(rust, 'generated', 'bindings.rs'), false);
    checks.push({
      nameEn: '.gitattributes recognizes linguist-generated',
      nameEs: '.gitattributes reconoce linguist-generated',
      ok: generated?.kind === 'GENERATED',
      detail: JSON.stringify(generated),
    });

    const vendored = await context.decide(join(rust, 'third_party', 'lib.rs'), false);
    checks.push({
      nameEn: '.gitattributes recognizes linguist-vendored',
      nameEs: '.gitattributes reconoce linguist-vendored',
      ok: vendored?.kind === 'VENDORED',
      detail: JSON.stringify(vendored),
    });

    const repomix = decideByRepomixPolicy(join(root, 'node-app', 'node_modules'), true);
    checks.push({
      nameEn: 'Repomix policy filters installed dependencies',
      nameEs: 'la política Repomix filtra dependencias instaladas',
      ok: repomix?.kind === 'NODE_DEPENDENCIES',
      detail: JSON.stringify(repomix),
    });

    let failed = 0;
    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${pick(check.nameEn, check.nameEs)}`);
      if (!check.ok) {
        failed += 1;
        console.log(`  ${pick('actual', 'real')}: ${check.detail}`);
      }
    }

    if (failed > 0) {
      console.error(`\nFAIL: ${failed} ${pick('incorrect context check(s).', 'comprobación(es) de contexto incorrecta(s).')}`);
      process.exitCode = 1;
    } else {
      console.log(`\nPASS: ${checks.length} ${pick('context checks are correct.', 'comprobaciones de contexto correctas.')}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden ${pick('Context Test', 'Prueba de contexto')}] ${message}`);
  process.exitCode = 1;
});
