import { decideAiTreeEntry } from '../ai/tree-policy';

interface Case {
  name: string;
  path: string;
  isDirectory: boolean;
  expectedPolicy: 'KEEP' | 'DROP';
  expectedKind: string;
}

const cases: Case[] = [
  {
    name: 'node_modules se omite',
    path: 'C:/dev/app/node_modules',
    isDirectory: true,
    expectedPolicy: 'DROP',
    expectedKind: 'NODE_DEPENDENCIES',
  },
  {
    name: 'dist se omite sin declararlo caché',
    path: 'C:/dev/app/dist',
    isDirectory: true,
    expectedPolicy: 'DROP',
    expectedKind: 'BUILD_OUTPUT',
  },
  {
    name: 'bundle ctags se omite solo en bin/ctags',
    path: 'C:/dev/an_graph_ia/bin/ctags',
    isDirectory: true,
    expectedPolicy: 'DROP',
    expectedKind: 'TOOL_BUNDLE',
  },
  {
    name: 'carpeta ctags fuera de bin se conserva',
    path: 'C:/dev/project/src/ctags',
    isDirectory: true,
    expectedPolicy: 'KEEP',
    expectedKind: 'SOURCE',
  },
  {
    name: '.aistudio se omite',
    path: 'C:/dev/app/assets/.aistudio',
    isDirectory: true,
    expectedPolicy: 'DROP',
    expectedKind: 'IDE_INTERNAL',
  },
  {
    name: '.env real se bloquea',
    path: 'C:/dev/app/.env',
    isDirectory: false,
    expectedPolicy: 'DROP',
    expectedKind: 'SENSITIVE_FILE',
  },
  {
    name: '.env.local se bloquea',
    path: 'C:/dev/app/.env.local',
    isDirectory: false,
    expectedPolicy: 'DROP',
    expectedKind: 'SENSITIVE_FILE',
  },
  {
    name: '.env.example solo aporta el nombre',
    path: 'C:/dev/app/.env.example',
    isDirectory: false,
    expectedPolicy: 'KEEP',
    expectedKind: 'SOURCE',
  },
  {
    name: '.env.sample solo aporta el nombre',
    path: 'C:/dev/app/.env.sample',
    isDirectory: false,
    expectedPolicy: 'KEEP',
    expectedKind: 'SOURCE',
  },
];

let failed = 0;
for (const testCase of cases) {
  const result = decideAiTreeEntry(testCase.path, testCase.isDirectory);
  const ok = result.policy === testCase.expectedPolicy && result.kind === testCase.expectedKind;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${testCase.name}`);
  if (!ok) {
    failed += 1;
    console.log(`  esperado: ${testCase.expectedPolicy} / ${testCase.expectedKind}`);
    console.log(`  obtenido: ${result.policy} / ${result.kind}`);
  }
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} caso(s) incorrecto(s).`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: ${cases.length} reglas de árbol IA correctas.`);
}
