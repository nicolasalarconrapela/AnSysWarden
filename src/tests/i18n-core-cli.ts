import { normalizeLanguage, resolveLanguage, setLanguage, t } from '../i18n';

interface TestCase {
  name: string;
  run: () => void;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.ANSYSWARDEN_LANG;
  try {
    if (value === undefined) delete process.env.ANSYSWARDEN_LANG;
    else process.env.ANSYSWARDEN_LANG = value;
    run();
  } finally {
    if (previous === undefined) delete process.env.ANSYSWARDEN_LANG;
    else process.env.ANSYSWARDEN_LANG = previous;
  }
}

const tests: TestCase[] = [
  {
    name: 'normalizes English variants',
    run: () => {
      assertEqual(normalizeLanguage('en'), 'en', 'plain en');
      assertEqual(normalizeLanguage('en-US'), 'en', 'en-US');
      assertEqual(normalizeLanguage('EN_gb'), 'en', 'EN_gb');
    },
  },
  {
    name: 'normalizes Spanish variants',
    run: () => {
      assertEqual(normalizeLanguage('es'), 'es', 'plain es');
      assertEqual(normalizeLanguage('es-ES'), 'es', 'es-ES');
      assertEqual(normalizeLanguage('ES_mx'), 'es', 'ES_mx');
    },
  },
  {
    name: 'rejects unsupported language values',
    run: () => {
      assertEqual(normalizeLanguage('fr'), null, 'fr');
      assertEqual(normalizeLanguage(''), null, 'empty language');
      assertEqual(normalizeLanguage(undefined), null, 'undefined language');
    },
  },
  {
    name: 'CLI language overrides environment language',
    run: () => withEnv('en', () => {
      assertEqual(resolveLanguage(['doctor', '--lang', 'es']), 'es', 'CLI must win over env');
    }),
  },
  {
    name: 'environment language is used when CLI has no language',
    run: () => withEnv('es', () => {
      assertEqual(resolveLanguage(['doctor']), 'es', 'environment language');
    }),
  },
  {
    name: 'English is the final fallback',
    run: () => withEnv(undefined, () => {
      assertEqual(resolveLanguage(['doctor']), 'en', 'default language');
    }),
  },
  {
    name: 'translates and interpolates Spanish messages',
    run: () => {
      setLanguage('es');
      assertEqual(t('common.path'), 'Ruta', 'Spanish translation');
      assertEqual(
        t('e2e.result_received', { elapsed: 1234 }),
        '[✓] Resultado recibido en 1234 ms',
        'Spanish interpolation',
      );
    },
  },
  {
    name: 'translates and interpolates English messages',
    run: () => {
      setLanguage('en');
      assertEqual(t('common.path'), 'Path', 'English translation');
      assertEqual(
        t('e2e.result_received', { elapsed: 1234 }),
        '[✓] Result received in 1234 ms',
        'English interpolation',
      );
    },
  },
  {
    name: 'unknown translation keys remain visible',
    run: () => {
      setLanguage('es');
      assertEqual(t('test.unknown.key'), 'test.unknown.key', 'unknown key fallback');
    },
  },
];

let failures = 0;

console.log('AnSysWarden · i18n Core Tests');
console.log('════════════════════════════════════════════════════');

for (const test of tests) {
  try {
    test.run();
    console.log(`[PASS] ${test.name}`);
  } catch (error) {
    failures += 1;
    console.error(`[FAIL] ${test.name}`);
    console.error(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('════════════════════════════════════════════════════');
console.log(`Result: ${tests.length - failures}/${tests.length} PASS`);

if (failures > 0) process.exitCode = 1;
