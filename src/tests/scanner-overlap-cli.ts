import { selectRecoverableSafeCandidates, type ScanCandidate } from '../scanner/scanner';

interface OverlapCase {
  id: string;
  description: string;
  candidates: ScanCandidate[];
  expectedPaths: string[];
  expectedBytes: number;
}

function candidate(
  path: string,
  classification: ScanCandidate['classification'],
  sizeBytes: number,
): ScanCandidate {
  return {
    path,
    classification,
    confidence: classification === 'SAFE_CACHE' ? 0.99 : 1,
    reason: 'Caso sintético de seguridad de solapamiento.',
    source: classification === 'SAFE_CACHE' ? 'rule' : 'fallback',
    sizeBytes,
  };
}

const CASES: OverlapCase[] = [
  {
    id: 'OVERLAP-001',
    description: 'SAFE padre + SAFE hijo cuenta una sola vez',
    candidates: [
      candidate('/home/user/.gradle/caches', 'SAFE_CACHE', 1_000),
      candidate('/home/user/.gradle/caches/modules-2', 'SAFE_CACHE', 600),
    ],
    expectedPaths: ['/home/user/.gradle/caches'],
    expectedBytes: 1_000,
  },
  {
    id: 'OVERLAP-002',
    description: 'SAFE padre + REVIEW hijo no permite contar el padre',
    candidates: [
      candidate('/work/cache', 'SAFE_CACHE', 1_000),
      candidate('/work/cache/client-copy', 'REVIEW_REQUIRED', 400),
    ],
    expectedPaths: [],
    expectedBytes: 0,
  },
  {
    id: 'OVERLAP-003',
    description: 'SAFE padre + USER_DATA hijo no permite contar el padre',
    candidates: [
      candidate('/work/generated', 'SAFE_CACHE', 2_000),
      candidate('/work/generated/photos', 'USER_DATA', 500),
    ],
    expectedPaths: [],
    expectedBytes: 0,
  },
  {
    id: 'OVERLAP-004',
    description: 'REVIEW padre + SAFE hijo permite contar solo el hijo',
    candidates: [
      candidate('/work/project', 'REVIEW_REQUIRED', 2_000),
      candidate('/work/project/node_modules', 'SAFE_CACHE', 800),
    ],
    expectedPaths: ['/work/project/node_modules'],
    expectedBytes: 800,
  },
  {
    id: 'OVERLAP-005',
    description: 'Dos hermanos SAFE se cuentan ambos',
    candidates: [
      candidate('/work/a/node_modules', 'SAFE_CACHE', 700),
      candidate('/work/b/node_modules', 'SAFE_CACHE', 900),
    ],
    expectedPaths: ['/work/a/node_modules', '/work/b/node_modules'],
    expectedBytes: 1_600,
  },
  {
    id: 'OVERLAP-006',
    description: 'Rutas Windows normalizan barras, mayúsculas y slash final',
    candidates: [
      candidate('C:\\Users\\Nico\\dev\\app\\node_modules\\', 'SAFE_CACHE', 1_200),
      candidate('c:/users/nico/dev/app/node_modules/pkg', 'SAFE_CACHE', 300),
    ],
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

console.log('AnSysWarden · Scanner Overlap Safety');
console.log('════════════════════════════════════════════════════');
console.log('Política: ante solapamiento, infraestimar antes que sobreestimar.');
console.log('');

for (const test of CASES) {
  const selected = selectRecoverableSafeCandidates(test.candidates);
  const actualPaths = selected.map((item) => item.path);
  const actualBytes = selected.reduce((sum, item) => sum + item.sizeBytes, 0);
  const ok = samePaths(actualPaths, test.expectedPaths) && actualBytes === test.expectedBytes;

  if (ok) passed += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'} ${test.id} · ${test.description}`);
  console.log(`├─ EXPECTED PATHS  ${test.expectedPaths.length ? test.expectedPaths.join(' | ') : '(ninguno)'}`);
  console.log(`├─ ACTUAL PATHS    ${actualPaths.length ? actualPaths.join(' | ') : '(ninguno)'}`);
  console.log(`├─ EXPECTED BYTES  ${test.expectedBytes}`);
  console.log(`└─ ACTUAL BYTES    ${actualBytes}`);
  console.log('');
}

console.log('════════════════════════════════════════════════════');
if (passed === CASES.length) {
  console.log(`🟢 OVERLAP GUARDRAIL: ${passed}/${CASES.length} pruebas superadas`);
} else {
  console.log(`🔴 OVERLAP GUARDRAIL: ${passed}/${CASES.length} pruebas superadas`);
  process.exitCode = 1;
}
