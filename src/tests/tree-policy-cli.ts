import { decideAiTreeEntry } from '../ai/tree-policy';

interface Case {
  name: string;
  path: string;
  isDirectory: boolean;
  expectedPolicy: 'KEEP' | 'DROP';
  expectedKind: string;
}

const cases: Case[] = [
  { name: 'node_modules is omitted', path: 'C:/dev/app/node_modules', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'NODE_DEPENDENCIES' },
  { name: 'dist is omitted without declaring it a cache', path: 'C:/dev/app/dist', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'BUILD_OUTPUT' },
  { name: 'ctags bundle is omitted only under bin/ctags', path: 'C:/dev/an_graph_ia/bin/ctags', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'TOOL_BUNDLE' },
  { name: 'ctags folder outside bin is kept', path: 'C:/dev/project/src/ctags', isDirectory: true, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
  { name: '.aistudio is omitted', path: 'C:/dev/app/assets/.aistudio', isDirectory: true, expectedPolicy: 'DROP', expectedKind: 'IDE_INTERNAL' },
  { name: 'real .env is blocked', path: 'C:/dev/app/.env', isDirectory: false, expectedPolicy: 'DROP', expectedKind: 'SENSITIVE_FILE' },
  { name: '.env.local is blocked', path: 'C:/dev/app/.env.local', isDirectory: false, expectedPolicy: 'DROP', expectedKind: 'SENSITIVE_FILE' },
  { name: '.env.example contributes only its name', path: 'C:/dev/app/.env.example', isDirectory: false, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
  { name: '.env.sample contributes only its name', path: 'C:/dev/app/.env.sample', isDirectory: false, expectedPolicy: 'KEEP', expectedKind: 'SOURCE' },
];

let failed = 0;
for (const testCase of cases) {
  const result = decideAiTreeEntry(testCase.path, testCase.isDirectory);
  const ok = result.policy === testCase.expectedPolicy && result.kind === testCase.expectedKind;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`);
  if (!ok) {
    failed += 1;
    console.log(`  expected: ${testCase.expectedPolicy} / ${testCase.expectedKind}`);
    console.log(`  actual:   ${result.policy} / ${result.kind}`);
  }
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} incorrect case(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: ${cases.length} AI-tree rules are correct.`);
}
