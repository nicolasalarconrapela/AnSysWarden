import { decideAiTreeEntry } from '../ai/tree-policy';
import { getLanguage } from '../i18n';

interface Case {
  nameEn: string;
  nameEs: string;
  path: string;
  isDirectory: boolean;
  expectedPolicy: 'KEEP' | 'DROP';
  expectedKind: string;
}

function pick(en: string, es: string): string {
  return getLanguage() === 'es' ? es : en;
}

const cases: Case[] = [
  { nameEn: 'node_modules is omitted', nameEs: 'node_modules se omite', path: 'C:/dev/app/node_modules', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'NODE_DEPENDENCIES' },
  { nameEn: 'dist is omitted without declaring it a cache', nameEs: 'dist se omite sin declararlo caché', path: 'C:/dev/app/dist', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'BUILD_OUTPUT' },
  { nameEn: 'ctags bundle is omitted only under bin/ctags', nameEs: 'el bundle ctags se omite solo bajo bin/ctags', path: 'C:/dev/an_graph_ia/bin/ctags', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'TOOL_BUNDLE' },
  { nameEn: 'ctags folder outside bin is kept', nameEs: 'una carpeta ctags fuera de bin se conserva', path: 'C:/dev/project/src/ctags', isDirectory: true, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
  { nameEn: '.aistudio is omitted', nameEs: '.aistudio se omite', path: 'C:/dev/app/assets/.aistudio', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'IDE_INTERNAL' },
  { nameEn: 'real .env is blocked', nameEs: 'un .env real se bloquea', path: 'C:/dev/app/.env', isDirectory: false, expectedPolicy: 'DROP', expectedKind: 'SENSITIVE_FILE' },
  { nameEn: '.env.local is blocked', nameEs: '.env.local se bloquea', path: 'C:/dev/app/.env.local', isDirectory: false, expectedPolicy: 'DROP', expectedKind: 'SENSITIVE_FILE' },
  { nameEn: '.env.example contributes only its name', nameEs: '.env.example aporta solo su nombre', path: 'C:/dev/app/.env.example', isDirectory: false, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
  { nameEn: '.env.sample contributes only its name', nameEs: '.env.sample aporta solo su nombre', path: 'C:/dev/app/.env.sample', isDirectory: false, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
];

let failed = 0;
for (const testCase of cases) {
  const result = decideAiTreeEntry(testCase.path, testCase.isDirectory);
  const ok = result.policy === testCase.expectedPolicy && result.kind === testCase.expectedKind;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${pick(testCase.nameEn, testCase.nameEs)}`);
  if (!ok) {
    failed += 1;
    console.log(`  ${pick('expected', 'esperado')}: ${testCase.expectedPolicy} / ${testCase.expectedKind}`);
    console.log(`  ${pick('actual', 'real')}:   ${result.policy} / ${result.kind}`);
  }
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} ${pick('incorrect case(s).', 'caso(s) incorrecto(s).')}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: ${cases.length} ${pick('AI-tree rules are correct.', 'reglas del árbol IA son correctas.')}`);
}
