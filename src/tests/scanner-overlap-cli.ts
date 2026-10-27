import { selectRecoverableSafeCandidates, type ScanCandidate } from '../application/scan/scan-service';
import { getLanguage } from '../i18n';

interface OverlapCase {
  id: string;
  descriptionEn: string;
  descriptionEs: string;
  candidates: ScanCandidate[];
  expectedPaths: string[];
  expectedBytes: number;
}

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

function candidate(path: string, classification: ScanCandidate['classification'], sizeBytes: number): ScanCandidate {
  return {
    path,
    classification,
    confidence: classification === 'SAFE_CACHE' ? 0.99 : 1,
    reason: pick('Synthetic overlap-safety case.', 'Caso sintético de seguridad por solapamiento.'),
    source: classification === 'SAFE_CACHE' ? 'rule' : 'fallback',
    sizeBytes,
  };
}

const CASES: OverlapCase[] = [
  {
    id: 'OVERLAP-001',
    descriptionEn: 'SAFE parent + SAFE child counts only once',
    descriptionEs: 'Padre SAFE + hijo SAFE cuenta solo una vez',
    candidates: [candidate('/home/user/.gradle/caches', 'SAFE_CACHE', 1_000), candidate('/home/user/.gradle/caches/modules-2', 'SAFE_CACHE', 600)],
    expectedPaths: ['/home/user/.gradle/caches'],
    expectedBytes: 1_000,
  },
  {
    id: 'OVERLAP-002',
    descriptionEn: 'SAFE parent + REVIEW child prevents counting the parent',
    descriptionEs: 'Padre SAFE + hijo REVIEW impide contar el padre',
    candidates: [candidate('/work/cache', 'SAFE_CACHE', 1_000), candidate('/work/cache/client-copy', 'REVIEW_REQUIRED', 400)],
    expectedPaths: [],
    expectedBytes: 0,
  },
  {
    id: 'OVERLAP-003',
    descriptionEn: 'SAFE parent + USER_DATA child prevents counting the parent',
    descriptionEs: 'Padre SAFE + hijo USER_DATA impide contar el padre',
    candidates: [candidate('/work/generated', 'SAFE_CACHE', 2_000), candidate('/work/generated/photos', 'USER_DATA', 500)],
    expectedPaths: [],
    expectedBytes: 0,
  },
  {
    id: 'OVERLAP-004',
    descriptionEn: 'REVIEW parent + SAFE child counts only the child',
    descriptionEs: 'Padre REVIEW + hijo SAFE cuenta solo el hijo',
    candidates: [candidate('/work/project', 'REVIEW_REQUIRED', 2_000), candidate('/work/project/node_modules', 'SAFE_CACHE', 800)],
    expectedPaths: ['/work/project/node_modules'],
    expectedBytes: 800,
  },
  {
    id: 'OVERLAP-005',
    descriptionEn: 'Two SAFE siblings are both counted',
    descriptionEs: 'Dos hermanos SAFE se cuentan ambos',
    candidates: [candidate('/work/a/node_modules', 'SAFE_CACHE', 700), candidate('/work/b/node_modules', 'SAFE_CACHE', 900)],
    expectedPaths: ['/work/a/node_modules', '/work/b/node_modules'],
    expectedBytes: 1_600,
  },
  {
    id: 'OVERLAP-006',
    descriptionEn: 'Windows paths normalize slashes, case, and trailing separators',
    descriptionEs: 'Las rutas Windows normalizan barras, mayúsculas y separadores finales',
    candidates: [candidate('C:\\Users\\Nico\\dev\\app\\node_modules\\', 'SAFE_CACHE', 1_200), candidate('c:/users/nico/dev/app/node_modules/pkg', 'SAFE_CACHE', 300)],
    expectedPaths: ['C:\\Users\\Nico\\dev\\app\\node_modules\\'],
    expectedBytes: 1_200,
  },
];

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePaths(actual: string[], expected: string[]): boolean {
  const a = actual.map(normalize).sort();
  const e = expected.map(normalize).sort();
  return a.length === e.length && a.every((item, index) => item === e[index]);
}

let passed = 0;

console.log(`AnSysWarden · ${pick('Scanner Overlap Safety', 'Seguridad de solapamientos del escáner')}`);
console.log('════════════════════════════════════════════════════');
console.log(pick(
  'Policy: when paths overlap, underestimate rather than overestimate recoverable space.',
  'Política: cuando las rutas se solapan, se prefiere infraestimar antes que sobreestimar el espacio recuperable.',
));
console.log('');

for (const test of CASES) {
  const selected = selectRecoverableSafeCandidates(test.candidates);
  const actualPaths = selected.map((item) => item.path);
  const actualBytes = selected.reduce((sum, item) => sum + item.sizeBytes, 0);
  const ok = samePaths(actualPaths, test.expectedPaths) && actualBytes === test.expectedBytes;

  if (ok) passed += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'} ${test.id} · ${pick(test.descriptionEn, test.descriptionEs)}`);
  console.log(`├─ ${pick('EXPECTED PATHS', 'RUTAS ESPERADAS').padEnd(16)} ${test.expectedPaths.length ? test.expectedPaths.join(' | ') : pick('(none)', '(ninguna)')}`);
  console.log(`├─ ${pick('ACTUAL PATHS', 'RUTAS REALES').padEnd(16)} ${actualPaths.length ? actualPaths.join(' | ') : pick('(none)', '(ninguna)')}`);
  console.log(`├─ ${pick('EXPECTED BYTES', 'BYTES ESPERADOS').padEnd(16)} ${test.expectedBytes}`);
  console.log(`└─ ${pick('ACTUAL BYTES', 'BYTES REALES').padEnd(16)} ${actualBytes}`);
  console.log('');
}

console.log('════════════════════════════════════════════════════');
if (passed === CASES.length) {
  console.log(`🟢 ${pick('OVERLAP GUARDRAIL', 'GUARDRAIL DE SOLAPAMIENTO')}: ${passed}/${CASES.length} ${pick('tests passed', 'pruebas superadas')}`);
} else {
  console.log(`🔴 ${pick('OVERLAP GUARDRAIL', 'GUARDRAIL DE SOLAPAMIENTO')}: ${passed}/${CASES.length} ${pick('tests passed', 'pruebas superadas')}`);
  process.exitCode = 1;
}
