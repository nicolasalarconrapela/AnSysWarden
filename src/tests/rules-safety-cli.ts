import { classifyByRules } from '../ai/rules';
import type { Classification } from '../ai/types';

interface RuleCase {
  id: string;
  description: string;
  input: string;
  expected: Classification | null;
}

const CASES: RuleCase[] = [
  {
    id: 'RULE-001',
    description: 'Documents gana frente a node_modules',
    input: '/home/user/Documents/web/node_modules',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-002',
    description: 'Pictures gana frente a .cache',
    input: '/storage/emulated/0/Pictures/familia/.cache',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-003',
    description: 'DCIM gana frente a build',
    input: '/storage/emulated/0/DCIM/Camera/build',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-004',
    description: 'Download gana frente a node_modules',
    input: '/storage/emulated/0/Download/project/node_modules',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-005',
    description: 'Movies gana frente a dist',
    input: '/storage/emulated/0/Movies/client/dist',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-006',
    description: 'Backups/build queda protegido',
    input: '/home/user/Backups/client/build',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-007',
    description: 'Savegames/cache queda protegido',
    input: '/home/user/Games/example/savegames/cache',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-008',
    description: 'Projects/dist queda protegido',
    input: '/home/user/Projects/cliente/dist',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-009',
    description: 'Config/.cache queda protegido',
    input: '/home/user/app/config/.cache',
    expected: 'USER_DATA',
  },
  {
    id: 'RULE-010',
    description: 'build genérico no puede autorizar SAFE_CACHE',
    input: '/home/user/work/build',
    expected: null,
  },
  {
    id: 'RULE-011',
    description: 'dist genérico no puede autorizar SAFE_CACHE',
    input: '/home/user/work/dist',
    expected: null,
  },
  {
    id: 'RULE-012',
    description: '.cache genérico no puede autorizar SAFE_CACHE',
    input: '/home/user/work/.cache',
    expected: null,
  },
  {
    id: 'RULE-013',
    description: 'Gradle caches conocida sí se autoriza',
    input: '/home/user/.gradle/caches/modules-2',
    expected: 'SAFE_CACHE',
  },
  {
    id: 'RULE-014',
    description: 'node_modules fuera de zonas protegidas sigue siendo regenerable',
    input: '/home/user/dev/demo/node_modules',
    expected: 'SAFE_CACHE',
  },
];

let failed = 0;

console.log('\nAnSysWarden · Guardrails deterministas');
console.log('════════════════════════════════════════════════════');
console.log('Este test NO usa Gemma ni Internet. Solo comprueba las reglas que pueden autorizar SAFE_CACHE.');

for (const test of CASES) {
  const result = classifyByRules(test.input);
  const actual = result?.classification ?? null;
  const passed = actual === test.expected;
  if (!passed) failed += 1;

  console.log('\n────────────────────────────────────────────────────');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${test.id}`);
  console.log(`Caso:      ${test.description}`);
  console.log(`Input:     ${test.input}`);
  console.log(`Esperado:  ${test.expected ?? 'SIN AUTORIZACIÓN LOCAL'}`);
  console.log(`Actual:    ${actual ?? 'SIN AUTORIZACIÓN LOCAL'}`);
  if (result) console.log(`Motivo:    ${result.reason}`);
  if (actual === 'SAFE_CACHE') {
    console.log('En humano: una regla local explícita está concediendo permiso de caché segura.');
  } else if (actual === 'USER_DATA') {
    console.log('En humano: la zona protegida gana y el contenido no se considera borrable.');
  } else {
    console.log('En humano: las reglas locales NO autorizan el borrado; cualquier IA solo podrá recomendar revisión.');
  }
}

console.log('\n════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`🟢 GUARDRAILS LOCALES: ${CASES.length}/${CASES.length} pruebas superadas`);
} else {
  console.log(`🔴 GUARDRAILS LOCALES: ${failed} fallo(s) crítico(s)`);
  process.exitCode = 2;
}
