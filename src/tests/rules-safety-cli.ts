import { classifyByRules } from '../core/classification/rules';
import type { Classification } from '../core/classification/types';
import { getLanguage } from '../i18n';

interface RuleCase {
  id: string;
  descriptionEn: string;
  descriptionEs: string;
  input: string;
  expected: Classification | null;
}

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

const CASES: RuleCase[] = [
  { id: 'RULE-001', descriptionEn: 'Documents wins over node_modules', descriptionEs: 'Documents gana frente a node_modules', input: '/home/user/Documents/web/node_modules', expected: 'USER_DATA' },
  { id: 'RULE-002', descriptionEn: 'Pictures wins over .cache', descriptionEs: 'Pictures gana frente a .cache', input: '/storage/emulated/0/Pictures/family/.cache', expected: 'USER_DATA' },
  { id: 'RULE-003', descriptionEn: 'DCIM wins over build', descriptionEs: 'DCIM gana frente a build', input: '/storage/emulated/0/DCIM/Camera/build', expected: 'USER_DATA' },
  { id: 'RULE-004', descriptionEn: 'Download wins over node_modules', descriptionEs: 'Download gana frente a node_modules', input: '/storage/emulated/0/Download/project/node_modules', expected: 'USER_DATA' },
  { id: 'RULE-005', descriptionEn: 'Movies wins over dist', descriptionEs: 'Movies gana frente a dist', input: '/storage/emulated/0/Movies/client/dist', expected: 'USER_DATA' },
  { id: 'RULE-006', descriptionEn: 'Backups/build remains protected', descriptionEs: 'Backups/build permanece protegido', input: '/home/user/Backups/client/build', expected: 'USER_DATA' },
  { id: 'RULE-007', descriptionEn: 'Savegames/cache remains protected', descriptionEs: 'Savegames/cache permanece protegido', input: '/home/user/Games/example/savegames/cache', expected: 'USER_DATA' },
  { id: 'RULE-008', descriptionEn: 'Projects/dist remains protected', descriptionEs: 'Projects/dist permanece protegido', input: '/home/user/Projects/client/dist', expected: 'USER_DATA' },
  { id: 'RULE-009', descriptionEn: 'Config/.cache remains protected', descriptionEs: 'Config/.cache permanece protegido', input: '/home/user/app/config/.cache', expected: 'USER_DATA' },
  { id: 'RULE-010', descriptionEn: 'Generic build cannot authorize SAFE_CACHE', descriptionEs: 'Un build genérico no puede autorizar SAFE_CACHE', input: '/home/user/work/build', expected: null },
  { id: 'RULE-011', descriptionEn: 'Generic dist cannot authorize SAFE_CACHE', descriptionEs: 'Un dist genérico no puede autorizar SAFE_CACHE', input: '/home/user/work/dist', expected: null },
  { id: 'RULE-012', descriptionEn: 'Generic .cache cannot authorize SAFE_CACHE', descriptionEs: 'Un .cache genérico no puede autorizar SAFE_CACHE', input: '/home/user/work/.cache', expected: null },
  { id: 'RULE-013', descriptionEn: 'Known Gradle cache is authorized', descriptionEs: 'Una caché Gradle conocida sí está autorizada', input: '/home/user/.gradle/caches/modules-2', expected: 'SAFE_CACHE' },
  { id: 'RULE-014', descriptionEn: 'node_modules outside protected zones remains regenerable', descriptionEs: 'node_modules fuera de zonas protegidas sigue siendo regenerable', input: '/home/user/dev/demo/node_modules', expected: 'SAFE_CACHE' },
];

let failed = 0;

console.log(`\nAnSysWarden · ${pick('Deterministic Guardrails', 'Guardrails deterministas')}`);
console.log('════════════════════════════════════════════════════');
console.log(pick(
  'This test does NOT use Gemma or the Internet. It only checks rules that are allowed to authorize SAFE_CACHE.',
  'Esta prueba NO usa Gemma ni Internet. Solo comprueba reglas autorizadas para conceder SAFE_CACHE.',
));

for (const test of CASES) {
  const result = classifyByRules(test.input);
  const actual = result?.classification ?? null;
  const passed = actual === test.expected;
  if (!passed) failed += 1;

  console.log('\n────────────────────────────────────────────────────');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${test.id}`);
  console.log(`${pick('Case', 'Caso')}:      ${pick(test.descriptionEn, test.descriptionEs)}`);
  console.log(`${pick('Input', 'Entrada')}:     ${test.input}`);
  console.log(`${pick('Expected', 'Esperado')}:  ${test.expected ?? pick('NO LOCAL AUTHORIZATION', 'SIN AUTORIZACIÓN LOCAL')}`);
  console.log(`${pick('Actual', 'Actual')}:    ${actual ?? pick('NO LOCAL AUTHORIZATION', 'SIN AUTORIZACIÓN LOCAL')}`);
  if (result) console.log(`${pick('Reason', 'Motivo')}:    ${result.reason}`);
  if (actual === 'SAFE_CACHE') {
    console.log(pick('Human view: an explicit local rule is granting safe-cache authorization.', 'En humano: una regla local explícita está concediendo autorización de caché segura.'));
  } else if (actual === 'USER_DATA') {
    console.log(pick('Human view: the protected zone wins and the content is not considered deletable.', 'En humano: gana la zona protegida y el contenido no se considera borrable.'));
  } else {
    console.log(pick('Human view: local rules do NOT authorize deletion; any AI may only recommend review/protection.', 'En humano: las reglas locales NO autorizan borrado; la IA solo puede recomendar revisión/protección.'));
  }
}

console.log('\n════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`🟢 ${pick('LOCAL GUARDRAILS', 'GUARDRAILS LOCALES')}: ${CASES.length}/${CASES.length} ${pick('tests passed', 'pruebas superadas')}`);
} else {
  console.log(`🔴 ${pick('LOCAL GUARDRAILS', 'GUARDRAILS LOCALES')}: ${failed} ${pick('critical failure(s)', 'fallo(s) crítico(s)')}`);
  process.exitCode = 2;
}
