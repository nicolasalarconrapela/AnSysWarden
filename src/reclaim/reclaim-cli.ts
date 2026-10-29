import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { BackendStorage } from '../backend/storage';
import { isScanDocument, type ScanDocument } from '../backend/types';
import { DustScanner } from '../dust/dust-scanner';
import { ScanCache } from '../infrastructure/persistence/scan-cache';
import {
  analyzeAmbiguousCandidates,
  type ReclaimAiProgressEvent,
  type ReclaimAiResult,
} from './reclaim-ai';
import {
  buildReclaimReport,
  formatBytes,
  type ReclaimCandidate,
  type ReclaimReport,
  type ReclaimTreeNode,
} from './reclaim-engine';
import type { ContentDomain, ProjectLifecycle, ReclaimQuestion } from './reclaim-policy';

function usage(): never {
  console.log('AnSysWarden · Reclaim');
  console.log('────────────────────────────────────────');
  console.log('Uso:');
  console.log('  ./ansys-reclaim scan <ruta> [--depth N] [--min-size SIZE] [--max N] [--tree] [--ai] [--ai-max N] [--project-state active|paused|finished]');
  console.log('  ./ansys-reclaim latest [--max N] [--tree] [--ai] [--ai-max N] [--project-state active|paused|finished]');
  console.log('  ./ansys-reclaim show <scan-id> [--max N] [--tree] [--ai] [--ai-max N] [--project-state active|paused|finished]');
  console.log(`  ./ansys-reclaim json '<scan-json>' [--max N] [--flat] [--ai] [--ai-max N] [--project-state active|paused|finished]`);
  console.log('  ./ansys-reclaim json <archivo.json> [--max N] [--flat] [--ai] [--ai-max N] [--project-state active|paused|finished]');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readPositiveInt(args: string[], name: string, fallback: number): number {
  const raw = readOption(args, name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 1000) {
    throw new Error(`${name} debe ser un entero entre 1 y 1000.`);
  }
  return value;
}

function readProjectState(args: string[]): ProjectLifecycle | undefined {
  const raw = readOption(args, '--project-state');
  if (raw === undefined) return undefined;
  if (raw === 'active' || raw === 'paused' || raw === 'finished') return raw;
  throw new Error('--project-state debe ser active, paused o finished.');
}

function parseScanJson(raw: string): ScanDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON inválido: ${reason}`);
  }

  if (!isScanDocument(parsed)) {
    throw new Error('El JSON no cumple el contrato ansyswarden.scan.v1. No se analizará.');
  }

  return parsed;
}

async function loadScanJson(input: string): Promise<{ scan: ScanDocument; source: string }> {
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    return { scan: parseScanJson(trimmed), source: 'argumento JSON' };
  }

  try {
    const raw = await readFile(input, 'utf8');
    return { scan: parseScanJson(raw), source: input };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer el archivo JSON ${input}: ${reason}`);
  }
}

function printGroup(title: string, rows: ReclaimCandidate[], max: number): void {
  console.log(`\n${title} (${Math.min(rows.length, max)}/${rows.length})`);
  console.log('────────────────────────────────────────');
  if (rows.length === 0) {
    console.log('  Ninguno.');
    return;
  }

  for (const row of rows.slice(0, max)) {
    console.log(`${formatBytes(row.sizeBytes).padStart(10)}  ${row.path}`);
    console.log(`            ${row.reason}`);
  }
}

function printTree(report: ReclaimReport, max: number): void {
  console.log(`\nÁRBOL (${Math.min(report.totalEntries, max)}/${report.totalEntries})`);
  console.log('────────────────────────────────────────');

  let printed = 0;
  const render = (node: ReclaimTreeNode, prefix: string, last: boolean, isRoot: boolean): void => {
    if (printed >= max) return;
    printed += 1;

    const branch = isRoot ? '' : `${prefix}${last ? '└── ' : '├── '}`;
    console.log(`${branch}${node.name} · ${formatBytes(node.sizeBytes)} · ${formatTreeDecision(node.decision)}`);

    const childPrefix = isRoot ? '' : `${prefix}${last ? '    ' : '│   '}`;
    for (let index = 0; index < node.children.length; index += 1) {
      if (printed >= max) break;
      render(node.children[index], childPrefix, index === node.children.length - 1, false);
    }
  };

  for (let index = 0; index < report.tree.length; index += 1) {
    if (printed >= max) break;
    render(report.tree[index], '', index === report.tree.length - 1, true);
  }

  if (report.totalEntries > printed) {
    console.log(`… ${report.totalEntries - printed} entradas omitidas por --max ${max}`);
  }

  console.log('');
  console.log('Leyenda: ELIMINAR = regla determinista · REVISAR = falta evidencia técnica · PREGUNTAR = falta intención del usuario · PROTEGER = datos protegidos');
}

function printScopes(report: ReclaimReport): void {
  if (report.context.scopes.length === 0) return;

  console.log('\nÁMBITOS DETECTADOS');
  console.log('────────────────────────────────────────');
  for (const scope of report.context.scopes) {
    const confidence = Math.round(scope.domainConfidence * 100);
    console.log(`${scope.name} · ${formatDomain(scope.domain)} · ${confidence}%`);
    console.log(`  ${scope.path}`);
    if (scope.projectLifecycle) {
      console.log(`  Estado: ${formatProjectState(scope.projectLifecycle)}`);
    }
  }
}

function printQuestions(report: ReclaimReport): void {
  if (report.questions.length === 0) return;

  console.log('\nPREGUNTAS PENDIENTES');
  console.log('────────────────────────────────────────');
  for (const question of report.questions) {
    console.log(`? ${question.prompt}`);
    console.log(`  Ruta: ${question.path}`);
    console.log(`  Motivo: ${question.reason}`);
  }
}

function canAskInteractively(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptQuestion(question: ReclaimQuestion): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\nPREGUNTA NECESARIA');
    console.log('────────────────────────────────────────');
    console.log(`? ${question.prompt}`);
    console.log(`  Ruta: ${question.path}`);
    console.log(`  ${question.reason}`);
    console.log('');

    question.options.forEach((option, index) => {
      console.log(`  ${index + 1}) ${option.label}`);
    });

    while (true) {
      const answer = (await rl.question(`\nElige [1-${question.options.length}]: `)).trim().toLowerCase();
      const numeric = Number.parseInt(answer, 10);
      const selected = Number.isInteger(numeric) && numeric >= 1 && numeric <= question.options.length
        ? question.options[numeric - 1]?.value
        : answer;

      const option = question.options.find((candidate) => candidate.value === selected);
      if (option) {
        console.log(`Respuesta: ${option.label}`);
        return option.value;
      }

      console.log(`Opción no válida. Escribe un número entre 1 y ${question.options.length} o uno de los valores mostrados.`);
    }
  } finally {
    rl.close();
  }
}

async function buildReportWithContext(
  scan: ScanDocument,
  projectState?: ProjectLifecycle,
): Promise<ReclaimReport> {
  const answers: Record<string, string> = {};
  let report = buildReclaimReport(scan, {
    projectLifecycle: projectState,
    answers,
  });

  if (!report.needsUserInput || !canAskInteractively()) return report;

  while (report.needsUserInput) {
    const question = report.questions[0];
    if (!question) break;

    const answer = await promptQuestion(question);
    answers[question.id] = answer;

    report = buildReclaimReport(scan, {
      projectLifecycle: projectState,
      answers,
    });
  }

  return report;
}

function printAiResult(result: ReclaimAiResult): void {
  console.log('\nGEMMA · EVIDENCIA SOBRE CASOS AMBIGUOS');
  console.log('────────────────────────────────────────');
  console.log(`Modelo: ${result.model}`);
  console.log('Seguridad: Gemma aporta evidencia; NO puede autorizar ELIMINAR.');

  if (result.analyzed.length === 0 && result.failures.length === 0) {
    console.log('  No había candidatos ambiguos seleccionables para Gemma.');
  } else if (result.analyzed.length === 0 && result.failures.length > 0) {
    console.log(`  Se intentaron ${result.failures.length} candidato(s), pero no se obtuvo evidencia válida.`);
  }

  for (const finding of result.analyzed) {
    const evidence = finding.evidence;
    console.log(`\n${formatBytes(finding.sizeBytes).padStart(10)}  ${finding.path}`);
    console.log(`  Regenerable: ${evidence.regenerability} · Riesgo datos: ${evidence.userDataRisk} · Confianza: ${Math.round(evidence.confidence * 100)}%`);
    console.log(`  Gemma: ${evidence.reason}`);
    for (const item of evidence.evidence) console.log(`  - ${item}`);
    console.log('  Decisión efectiva: REVISAR');
  }

  for (const failure of result.failures) {
    console.log(`\n  [AI no disponible] ${failure.path}`);
    console.log(`  ${failure.error}`);
  }
}

function createAiProgressHandler(): (event: ReclaimAiProgressEvent) => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let liveLabel = '';
  const tty = Boolean(process.stdout.isTTY);

  const clearTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const clearLiveLine = (): void => {
    if (tty) process.stdout.write('\r\x1b[2K');
  };

  const renderLive = (): void => {
    if (!tty || !liveLabel) return;
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    process.stdout.write(`\r\x1b[2K${liveLabel} · ${elapsedSeconds} s…`);
  };

  const startLive = (label: string): void => {
    clearTimer();
    clearLiveLine();
    liveLabel = label;
    startedAt = Date.now();
    if (tty) {
      renderLive();
      timer = setInterval(renderLive, 1000);
    } else {
      console.log(label);
    }
  };

  const finishLive = (label: string, durationMs: number): void => {
    clearTimer();
    clearLiveLine();
    liveLabel = '';
    console.log(`${label} · ${formatDuration(durationMs)}`);
  };

  return (event: ReclaimAiProgressEvent): void => {
    if (event.type === 'selection') {
      console.log(`  Seleccionados para Gemma: ${event.selected}/${event.requested} · modelo ${event.model}`);
      return;
    }

    if (event.type === 'warmup-start') {
      startLive(`  [··] Preparando ${event.model}`);
      return;
    }

    if (event.type === 'warmup-done') {
      finishLive(`  [✓] ${event.model} preparado`, event.durationMs);
      return;
    }

    if (event.type === 'warmup-failed') {
      finishLive(`  [!] No se pudo preparar ${event.model}`, event.durationMs);
      return;
    }

    if (event.type === 'candidate-start') {
      startLive(`  [${event.index}/${event.total}] Analizando ${displayName(event.path)}`);
      return;
    }

    if (event.type === 'candidate-done') {
      finishLive(`  [✓] [${event.index}/${event.total}] ${displayName(event.path)} analizado`, event.durationMs);
      return;
    }

    if (event.type === 'candidate-failed') {
      finishLive(`  [!] [${event.index}/${event.total}] ${displayName(event.path)} sin resultado`, event.durationMs);
    }
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

async function printReport(
  scan: ScanDocument,
  report: ReclaimReport,
  max: number,
  tree: boolean,
  ai: boolean,
  aiMax: number,
): Promise<void> {
  console.log('\nAnSysWarden · Propuestas de espacio');
  console.log('════════════════════════════════════════');
  console.log(`Scan ID: ${scan.id}`);
  console.log(`Origen: ${scan.origin?.deviceRole ?? 'desconocido'} · ${scan.origin?.platform ?? scan.computer}`);
  console.log(`Ruta: ${scan.origin?.rootPath ?? '-'}`);
  console.log(`Dominio global: ${formatDomain(report.context.domain)} · confianza ${Math.round(report.context.domainConfidence * 100)}%`);
  console.log(`Entradas JSON: ${report.totalEntries}`);
  console.log(`Entradas analizadas: ${report.analyzedEntries}`);
  console.log(`Recuperable confirmado: ${formatBytes(report.confirmedRecoverableBytes)}`);
  console.log(`Propuestas: ${report.deleteCandidates.length} eliminar · ${report.reviewCandidates.length} revisar · ${report.protectCandidates.length} proteger · ${report.questions.length} preguntar`);
  console.log('Seguridad: esta orden NO borra archivos. Solo reglas locales deterministas pueden proponer ELIMINAR.');

  printScopes(report);

  if (report.rootFallbackUsed) {
    console.log('Aviso: el escaneo no contiene hijos utilizables; se analiza la raíz como REVISAR/PROTEGER/ELIMINAR según reglas.');
    console.log('Para propuestas más precisas, genera un escaneo con mayor profundidad o menor --min-size.');
  } else if (report.totalEntries <= 3) {
    console.log('Aviso: el escaneo contiene muy pocas entradas; las propuestas pueden ser demasiado generales.');
  }

  if (tree) {
    printTree(report, max);
  } else {
    printGroup('ELIMINAR', report.deleteCandidates, max);
    printGroup('REVISAR', report.reviewCandidates, max);
    printGroup('PROTEGER', report.protectCandidates, max);
  }

  printQuestions(report);

  if (report.needsUserInput) {
    if (!canAskInteractively()) {
      console.log('\nNo hay terminal interactiva disponible para responder las preguntas pendientes.');
      console.log('En este caso hay que aportar el contexto mediante opciones no interactivas específicas.');
    }
    if (ai) {
      console.log('IA pospuesta: primero hay que resolver las preguntas de contexto del usuario.');
    }
    return;
  }

  if (ai) {
    console.log(`\nAnalizando con Gemma hasta ${aiMax} candidato(s) ambiguo(s) principal(es)...`);
    const progress = createAiProgressHandler();
    const result = await analyzeAmbiguousCandidates(scan, report, aiMax, progress);
    printAiResult(result);
  }
}

async function findScanHere(storage: BackendStorage, cache: ScanCache, id: string): Promise<ScanDocument | null> {
  const original = await storage.getScan(id);
  if (original) return original;

  const cached = await cache.get(id);
  return cached?.scan ?? null;
}

async function findLatestScanHere(storage: BackendStorage, cache: ScanCache): Promise<ScanDocument | null> {
  const [originals, copies] = await Promise.all([storage.listScans(), cache.list()]);
  const candidates = [
    ...originals.map((scan) => ({ id: scan.id, createdAt: scan.createdAt })),
    ...copies.map((scan) => ({ id: scan.scanId, createdAt: scan.createdAt })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const candidate of candidates) {
    const scan = await findScanHere(storage, cache, candidate.id);
    if (scan) return scan;
  }

  return null;
}

async function run(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const storage = new BackendStorage();
  const cache = new ScanCache();
  const max = readPositiveInt(args, '--max', 30);
  const ai = hasFlag(args, '--ai');
  const aiMax = readPositiveInt(args, '--ai-max', 3);
  const projectState = readProjectState(args);

  if (command === 'scan') {
    const inputPath = args[0];
    if (!inputPath || inputPath.startsWith('--')) usage();
    const tree = hasFlag(args, '--tree');

    const depthRaw = readOption(args, '--depth');
    const depth = depthRaw === undefined ? undefined : Number.parseInt(depthRaw, 10);
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 32)) {
      throw new Error('--depth debe estar entre 1 y 32.');
    }

    const minSize = readOption(args, '--min-size');
    const scanner = new DustScanner(storage);

    console.log('\nAnSysWarden · Recuperar espacio');
    console.log('────────────────────────────────────────');
    console.log(`Escaneando: ${inputPath}`);
    console.log('Modo: solo lectura · no se eliminará ningún archivo');

    const result = await scanner.scan(inputPath, { depth, minSize });
    const report = await buildReportWithContext(result.scan, projectState);
    await printReport(result.scan, report, max, tree, ai, aiMax);
    return;
  }

  if (command === 'latest') {
    const tree = hasFlag(args, '--tree');
    const scan = await findLatestScanHere(storage, cache);
    if (!scan) throw new Error('No hay ningún escaneo disponible en este dispositivo.');
    const report = await buildReportWithContext(scan, projectState);
    await printReport(scan, report, max, tree, ai, aiMax);
    return;
  }

  if (command === 'show') {
    const id = args[0];
    if (!id || id.startsWith('--')) usage();
    const tree = hasFlag(args, '--tree');
    const scan = await findScanHere(storage, cache, id);
    if (!scan) throw new Error(`No existe el escaneo ${id} en este dispositivo.`);
    const report = await buildReportWithContext(scan, projectState);
    await printReport(scan, report, max, tree, ai, aiMax);
    return;
  }

  if (command === 'json') {
    const input = args[0];
    if (!input || input.startsWith('--')) usage();
    const { scan, source } = await loadScanJson(input);
    const tree = !hasFlag(args, '--flat');
    console.log('AnSysWarden · JSON directo');
    console.log('────────────────────────────────────────');
    console.log(`Entrada: ${source}`);
    console.log('Persistencia: no se guarda; solo se analiza en memoria.');
    const report = await buildReportWithContext(scan, projectState);
    await printReport(scan, report, max, tree, ai, aiMax);
    return;
  }

  usage();
}

function displayName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function formatTreeDecision(decision: ReclaimTreeNode['decision']): string {
  if (decision === 'DELETE') return 'ELIMINAR';
  if (decision === 'PROTECT') return 'PROTEGER';
  if (decision === 'KEEP') return 'CONSERVAR';
  if (decision === 'OPTIMIZE') return 'OPTIMIZAR';
  if (decision === 'ASK') return 'PREGUNTAR';
  if (decision === 'ROOT') return 'RAÍZ';
  return 'REVISAR';
}

function formatDomain(domain: ContentDomain): string {
  if (domain === 'development') return 'DESARROLLO';
  if (domain === 'game') return 'JUEGOS';
  if (domain === 'media') return 'MEDIA';
  if (domain === 'private') return 'PRIVADO';
  if (domain === 'application') return 'APLICACIÓN';
  if (domain === 'system') return 'SISTEMA';
  if (domain === 'backup') return 'BACKUP';
  if (domain === 'downloads') return 'DESCARGAS';
  if (domain === 'other') return 'OTRO';
  if (domain === 'mixed') return 'MIXTO';
  return 'DESCONOCIDO';
}

function formatProjectState(state: ProjectLifecycle): string {
  if (state === 'active') return 'EN DESARROLLO';
  if (state === 'paused') return 'PAUSADO';
  return 'FINALIZADO';
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Reclaim] ${message}`);
  process.exitCode = 1;
});