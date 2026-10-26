import { classifyByRules } from '../ai/rules';
import type { Classification } from '../ai/types';

interface RuleCase {
  id: string;
  description: string;
  input: string;
  expected: Classification | null;
}

const CASES: RuleCase[] = [
  { id: 'RULE-001', description: 'Documents wins over node_modules', input: '/home/user/Documents/web/node_modules', expected: 'USER_DATA' },
  { id: 'RULE-002', description: 'Pictures wins over .cache', input: '/storage/emulated/0/Pictures/family/.cache', expected: 'USER_DATA' },
  { id: 'RULE-003', description: 'DCIM wins over build', input: '/storage/emulated/0/DCIM/Camera/build', expected: 'USER_DATA' },
  { id: 'RULE-004', description: 'Download wins over node_modules', input: '/storage/emulated/0/Download/project/node_modules', expected: 'USER_DATA' },
  { id: 'RULE-005', description: 'Movies wins over dist', input: '/storage/emulated/0/Movies/client/dist', expected: 'USER_DATA' },
  { id: 'RULE-006', description: 'Backups/build remains protected', input: '/home/user/Backups/client/build', expected: 'USER_DATA' },
  { id: 'RULE-007', description: 'Savegames/cache remains protected', input: '/home/user/Games/example/savegames/cache', expected: 'USER_DATA' },
  { id: 'RULE-008', description: 'Projects/dist remains protected', input: '/home/user/Projects/client/dist', expected: 'USER_DATA' },
  { id: 'RULE-009', description: 'Config/.cache remains protected', input: '/home/user/app/config/.cache', expected: 'USER_DATA' },
  { id: 'RULE-010', description: 'Generic build cannot authorize SAFE_CACHE', input: '/home/user/work/build', expected: null },
  { id: 'RULE-011', description: 'Generic dist cannot authorize SAFE_CACHE', input: '/home/user/work/dist', expected: null },
  { id: 'RULE-012', description: 'Generic .cache cannot authorize SAFE_CACHE', input: '/home/user/work/.cache', expected: null },
  { id: 'RULE-013', description: 'Known Gradle cache is authorized', input: '/home/user/.gradle/caches/modules-2', expected: 'SAFE_CACHE' },
  { id: 'RULE-014', description: 'node_modules outside protected zones remains regenerable', input: '/home/user/dev/demo/node_modules', expected: 'SAFE_CACHE' },
];

let failed = 0;

console.log('\nAnSysWarden · Deterministic Guardrails');
console.log('════════════════════════════════════════════════════');
console.log('This test does NOT use Gemma or the Internet. It only checks rules that are allowed to authorize SAFE_CACHE.');

for (const test of CASES) {
  const result = classifyByRules(test.input);
  const actual = result?.classification ?? null;
  const passed = actual === test.expected;
  if (!passed) failed += 1;

  console.log('\n────────────────────────────────────────────────────');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${test.id}`);
  console.log(`Case:      ${test.description}`);
  console.log(`Input:     ${test.input}`);
  console.log(`Expected:  ${test.expected ?? 'NO LOCAL AUTHORIZATION'}`);
  console.log(`Actual:    ${actual ?? 'NO LOCAL AUTHORIZATION'}`);
  if (result) console.log(`Reason:    ${result.reason}`);
  if (actual === 'SAFE_CACHE') {
    console.log('Human view: an explicit local rule is granting safe-cache authorization.');
  } else if (actual === 'USER_DATA') {
    console.log('Human view: the protected zone wins and the content is not considered deletable.');
  } else {
    console.log('Human view: local rules do NOT authorize deletion; any AI may only recommend review/protection.');
  }
}

console.log('\n════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`🟢 LOCAL GUARDRAILS: ${CASES.length}/${CASES.length} tests passed`);
} else {
  console.log(`🔴 LOCAL GUARDRAILS: ${failed} critical failure(s)`);
  process.exitCode = 2;
}
