#!/usr/bin/env node
/**
 * Preflight de solo lectura: comprueba la estructura de testing y sus rutas.
 * No instala dependencias, no escanea carpetas personales y no crea archivos.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const groups = [
  '01-contratos', '02-inventario', '03-visor-html',
  '04-seguridad', '05-ia', '06-e2e',
];
const files = [
  ['pc-dust-scan-contract-cli.ts', '01-contratos'],
  ['pc-inventory-boundary-cli.ts', '01-contratos'],
  ['scanner-overlap-cli.ts', '02-inventario'],
  ['tree-policy-cli.ts', '03-visor-html'],
  ['rules-safety-cli.ts', '04-seguridad'],
  ['ai-safety.ts', '04-seguridad'],
  ['project-context-cli.ts', '05-ia'],
  ['ai-candidate-cli.ts', '05-ia'],
  ['cache-benchmark-100.ts', '05-ia'],
  ['cache-benchmark-runner.ts', '05-ia'],
  ['model-comparison-dataset.ts', '05-ia'],
  ['model-comparison-runner.ts', '05-ia'],
  ['backend-gemma-e2e-cli.ts', '06-e2e'],
  ['backend-json-smoke-cli.ts', '06-e2e'],
];

const exists = async path => {
  try { await stat(path); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};
const failures = [];
const check = (ok, title) => {
  console.log((ok ? '✓ [PASS] ' : '✗ [FAIL] ') + title);
  if (!ok) failures.push(title);
};

for (const group of groups) {
  check(await exists(join(root, 'tests', group, 'README.md')), 'Guía de ' + group);
  check(await exists(join(root, 'tests', 'resultados', group, '.gitkeep')), 'Resultados de ' + group);
}

for (const [name, group] of files) {
  const source = join(root, 'tests', group, name);
  const legacy = join(root, 'src', 'tests', name);
  const canonical = await exists(source);
  const compatible = await exists(legacy);
  check(canonical && compatible, name + ': fuente + acceso compatible');
  if (!canonical || !compatible) continue;

  const wrapper = await readFile(legacy, 'utf8');
  check(wrapper.includes(`../../tests/${group}/${name.slice(0, -3)}`),
    name + ': acceso antiguo apunta a ubicación nueva');

  const sourceText = await readFile(source, 'utf8');
  for (const match of sourceText.matchAll(/(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const specifier = match[1];
    const target = resolve(dirname(source), specifier);
    const found = await Promise.all([
      target + '.ts', target + '.tsx', join(target, 'index.ts'),
    ].map(exists));
    check(found.some(Boolean), name + ': dependencia ' + specifier);
  }
}

const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
check(config.include?.includes('tests/**/*.ts'), 'TypeScript incluye tests');
check(config.exclude?.includes('tests/fixtures/**'), 'TypeScript excluye fixtures generadas');
check(await exists(join(root, 'tests/fixtures/inventario/generate-pc-fixtures.mjs')), 'Generador organizado');
check(await exists(join(root, 'data/generate-pc-fixtures.mjs')), 'Generador anterior preservado');
check(await exists(join(root, 'tests/fixtures/backend-smoke.json')), 'Fixture JSON de backend preservada');
const launcher = await readFile(join(root, 'ansys'), 'utf8');
for (const name of ['rules-safety-cli.ts', 'scanner-overlap-cli.ts', 'tree-policy-cli.ts',
  'project-context-cli.ts', 'ai-candidate-cli.ts', 'cache-benchmark-runner.ts',
  'model-comparison-runner.ts', 'backend-gemma-e2e-cli.ts']) {
  const group = files.find(row => row[0] === name)[1];
  check(launcher.includes(`$ROOT_DIR/tests/${group}/${name}`),
    'CLI test conserva ruta de ' + name);
}
console.log('\nResultado: ' + (failures.length ? failures.length + ' FAIL' : 'PASS · estructura de tests coherente'));
if (failures.length) process.exitCode = 1;
