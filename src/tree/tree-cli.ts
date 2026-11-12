import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import { NativeTreeScanner, type TreeEntryRecord, type TreeIndexRecord, type TreeScanMetadata } from './native-tree-scanner';
import { writeNativeTreeHtml } from './tree-html';
import { runTreeAudit } from './tree-audit';
import { measureAllocatedSpace } from './tree-allocation';
import { analyzeTreeAge } from './tree-age';
import { analyzeTreeActivity } from './tree-activity';

function usage(): never {
  console.log('AnSysWarden Tree');
  console.log('Uso (entrada principal: ./ansys tree):');
  console.log('  ./ansys-tree scan <ruta> [--out indice.jsonl] [--html [archivo.html]]');
  console.log('  ./ansys-tree show [ruta] [--depth N] [--files] [--index indice.jsonl]');
  console.log('  ./ansys-tree html [--out archivo.html] [--allocation medicion.jsonl]');
  console.log('  ./ansys-tree audit [--branches ANDROID_Studio,OSS,AnSysWarden] [--out informe.json]');
  console.log('  ./ansys-tree allocated [--out medicion.jsonl]');
  console.log('  ./ansys-tree age [--days 180] [--top 25] [--out informe.json]');
  console.log('  ./ansys-tree activity [--days 180] [--out informe.json]');
  console.log('  ./ansys tree activity --days 180  # delega en ansys-tree');
  process.exit(1);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readOptionalPathOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const next = args[index + 1];
  return !next || next.startsWith('--') ? '' : next;
}

function readPositiveInt(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Valor inválido para ${name}: ${raw}`);
  return value;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * latest.json puede guardar rutas absolutas de otro workspace, o apuntar
 * a un índice eliminado. Nunca reescribir latest.json ni elegir a ciegas.
 * Únicamente se recuperan índices cuyo metadato corresponde a la MISMA raíz.
 */
async function loadLatestMetadata(): Promise<TreeScanMetadata> {
  const treeDir = resolve('.ansyswarden', 'tree');
  const latestPath = join(treeDir, 'latest.json');
  let latest: TreeScanMetadata;
  try {
    latest = JSON.parse(await readFile(latestPath, 'utf8')) as TreeScanMetadata;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('No existe ' + latestPath +
        '. Escanea primero con: ./ansys tree scan "C:/Users/nalar/Desktop" --html escritorio.html');
    }
    throw error;
  }
  if (!latest.id || !latest.rootPath || !latest.indexPath) {
    throw new Error('latest.json no contiene un escaneo válido. No se ha alterado ningún archivo.');
  }

  const scansDir = join(treeDir, 'scans');
  const direct = resolve(latest.indexPath);
  if (await isFile(direct)) return latest;

  // Caso 1: se movió el workspace; el índice sigue bajo scans/<id>.jsonl.
  const relocated = join(scansDir, latest.id + '.jsonl');
  if (await isFile(relocated)) {
    console.warn('[AVISO] Ruta del índice desplazada: ' + direct);
    console.warn('[AVISO] Se usa el mismo escaneo en: ' + relocated);
    return { ...latest, indexPath: relocated };
  }

  // Caso 2: latest.json quedó apuntando a un índice eliminado. Recuperar
  // solamente escaneos de la misma raíz, comprobando metadatos + JSONL.
  let entries: string[] = [];
  try {
    entries = (await readdir(scansDir))
      .filter(name => name.endsWith('.meta.json'))
      .sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of entries) {
    let candidate: TreeScanMetadata;
    try {
      candidate = JSON.parse(await readFile(join(scansDir, name), 'utf8')) as TreeScanMetadata;
    } catch {
      continue; // Solo omitir metadatos secundarios ilegibles.
    }
    if (!candidate.id || !candidate.rootPath || candidate.entries <= 0) continue;
    const sameRoot = process.platform === 'win32'
      ? candidate.rootPath.toLowerCase() === latest.rootPath.toLowerCase()
      : candidate.rootPath === latest.rootPath;
    if (!sameRoot) continue;
    // Para índices con ruta personalizada, conservar la ruta verificada.
    const candidates = [resolve(candidate.indexPath), join(scansDir, candidate.id + '.jsonl')];
    for (const indexPath of candidates) {
      if (!(await isFile(indexPath))) continue;
      console.warn('[AVISO] El índice referenciado por latest.json no existe: ' + direct);
      console.warn('[AVISO] Recuperado escaneo anterior de la misma raíz: ' + candidate.id);
      console.warn('[AVISO] Fecha del índice recuperado: ' + candidate.createdAt);
      return { ...candidate, indexPath };
    }
  }

  throw new Error(
    'Índice no encontrado: ' + direct + '\n' +
    'No hay un índice recuperable para la raíz ' + latest.rootPath + '.\n' +
    'No se han borrado ni modificado archivos. Para reconstruir el índice, ejecuta:\n' +
    '  ./ansys tree scan "' + latest.rootPath + '" --html escritorio.html\n' +
    'Revisa antes si se movió o limpió .ansyswarden/tree/scans/.'
  );
}

async function runScan(args: string[]): Promise<void> {
  const inputPath = args[0];
  if (!inputPath || inputPath.startsWith('--')) usage();

  const outputPath = readOption(args, '--out');
  const htmlOption = readOptionalPathOption(args, '--html');
  const scanner = new NativeTreeScanner();
  const startedAt = Date.now();

  console.log('\nAnSysWarden · Tree Scan');
  console.log('────────────────────────────────────────');
  console.log(`Ruta:       ${inputPath}`);
  console.log('Modo:       scanner nativo completo');
  console.log('Incluye:    carpetas + archivos + tamaños + fechas + errores');
  console.log('Escritura:  índice JSONL incremental');
  console.log(`HTML:       ${htmlOption === null ? 'no' : 'sí'}`);

  const result = await scanner.scan(inputPath, {
    ...(outputPath ? { outputPath } : {}),
    onProgress: (progress) => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      process.stdout.write(`\rEscaneando... ${progress.entries.toLocaleString('es-ES')} entradas · ${progress.files.toLocaleString('es-ES')} archivos · ${progress.directories.toLocaleString('es-ES')} carpetas · ${elapsed}s   `);
    },
  });

  process.stdout.write('\n');

  let htmlPath: string | undefined;
  if (htmlOption !== null) {
    htmlPath = await writeNativeTreeHtml({
      metadata: result,
      indexPath: result.indexPath,
      outputPath: resolve(htmlOption || `${result.id}.html`),
    });
  }

  console.log('────────────────────────────────────────');
  console.log(`Scan ID:     ${result.id}`);
  console.log(`Entradas:    ${result.entries.toLocaleString('es-ES')}`);
  console.log(`Archivos:    ${result.files.toLocaleString('es-ES')}`);
  console.log(`Carpetas:    ${result.directories.toLocaleString('es-ES')}`);
  console.log(`Symlinks:    ${result.symlinks.toLocaleString('es-ES')}`);
  console.log(`Errores:     ${result.errors.toLocaleString('es-ES')}`);
  console.log(`Tamaño:      ${formatBytes(result.sizeBytes)}`);
  console.log(`Índice:      ${result.indexPath}`);
  if (htmlPath) console.log(`HTML:        ${htmlPath}`);
}

async function runShow(args: string[]): Promise<void> {
  const pathArg = args.find((arg) => !arg.startsWith('--') && arg !== readOption(args, '--depth') && arg !== readOption(args, '--index'));
  const maxDepth = readPositiveInt(args, '--depth') ?? 3;
  const includeFiles = args.includes('--files');
  const metadata = await loadLatestMetadata();
  const indexPath = resolve(readOption(args, '--index') ?? metadata.indexPath);
  const rootFilter = pathArg ? resolve(pathArg) : metadata.rootPath;

  const summaries = new Map<string, number>();
  const entries: TreeEntryRecord[] = [];
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as TreeIndexRecord;
    if (record.record === 'directory-summary') {
      summaries.set(record.path, record.sizeBytes);
      continue;
    }
    if (record.record !== 'entry') continue;
    if (!record.path.toLowerCase().startsWith(rootFilter.toLowerCase())) continue;
    if (record.depth < 0) continue;
    if (!includeFiles && record.type === 'file') continue;
    entries.push(record);
  }

  if (entries.length === 0) throw new Error(`No se encontraron entradas bajo: ${rootFilter}`);

  const rootEntry = entries.find((entry) => entry.path.toLowerCase() === rootFilter.toLowerCase());
  const baseDepth = rootEntry?.depth ?? Math.min(...entries.map((entry) => entry.depth));
  const visible = entries
    .filter((entry) => entry.depth - baseDepth <= maxDepth)
    .sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      const aSize = a.type === 'directory' ? summaries.get(a.path) ?? 0 : a.sizeBytes;
      const bSize = b.type === 'directory' ? summaries.get(b.path) ?? 0 : b.sizeBytes;
      return bSize - aSize || a.name.localeCompare(b.name);
    });

  console.log('\nAnSysWarden · Tree');
  console.log('────────────────────────────────────────');
  console.log(`Raíz: ${rootFilter}`);
  console.log(`Profundidad: ${maxDepth} · Archivos: ${includeFiles ? 'sí' : 'no'}`);
  console.log('────────────────────────────────────────');

  for (const entry of visible) {
    const relativeDepth = Math.max(0, entry.depth - baseDepth);
    const size = entry.type === 'directory' ? summaries.get(entry.path) ?? 0 : entry.sizeBytes;
    const icon = entry.type === 'directory' ? '📁' : entry.type === 'file' ? '📄' : '↗';
    console.log(`${'  '.repeat(relativeDepth)}${icon} ${formatBytes(size).padStart(10)}  ${entry.name}`);
  }
}

async function runHtml(args: string[]): Promise<void> {
  const metadata = await loadLatestMetadata();
  if (metadata.entries === 0) {
    throw new Error(
      'El último índice está vacío (0 entradas). No se genera HTML. ' +
      'Vuelve a escanear una ruta válida, por ejemplo: ' +
      './ansys-tree scan "C:/Users/nalar/Desktop" --html escritorio.html'
    );
  }
  const indexPath = resolve(readOption(args, '--index') ?? metadata.indexPath);
  const outputPath = resolve(readOption(args, '--out') ?? `${metadata.id}.html`);
  const allocationPath = readOption(args, '--allocation');
  const htmlPath = await writeNativeTreeHtml({ metadata, indexPath, outputPath,
    ...(allocationPath ? { allocationPath } : {}),
  });

  console.log('\nAnSysWarden · Tree HTML');
  console.log('────────────────────────────────────────');
  console.log(`Índice: ${indexPath}`);
  console.log(`HTML:   ${htmlPath}`);
}

async function runAudit(args: string[]): Promise<void> {
  const metadata = await loadLatestMetadata();
  if (metadata.entries === 0) {
    throw new Error('El índice está vacío. Ejecuta un escaneo nativo válido antes de auditar.');
  }

  const branchArg = readOption(args, '--branches');
  const branchNames = branchArg
    ? branchArg.split(',').map(value => value.trim()).filter(Boolean)
    : undefined;
  const outputPath = readOption(args, '--out');
  console.log('\nAnSysWarden · Auditoría Tree (solo lectura)');
  console.log('────────────────────────────────────────');
  console.log('Índice: ' + metadata.indexPath);
  console.log('Fecha índice: ' + metadata.createdAt);
  console.log('Ramas: ' + (branchNames ?? ['ANDROID_Studio', 'OSS', 'AnSysWarden']).join(', '));
  console.log('Los recuentos en vivo no son cifras extraídas de TreeSize.');

  const result = await runTreeAudit(metadata, {
    ...(branchNames ? { branchNames } : {}),
    ...(outputPath ? { outputPath } : {}),
  });

  for (const branch of result.report.branches) {
    const signed = branch.deltaFiles >= 0 ? '+' : '';
    console.log('\n' + branch.name);
    console.log('  Índice: ' + branch.indexed.files.toLocaleString('es-ES') + ' archivos');
    console.log('  Ahora:  ' + branch.live.files.toLocaleString('es-ES') + ' archivos');
    console.log('  Cambio: ' + signed + branch.deltaFiles.toLocaleString('es-ES') + ' archivos');
    console.log('  Enlaces detectados: ' + branch.live.symlinks);
    console.log('  Errores: ' + branch.live.errors);
    for (const item of branch.topDifferences.slice(0, 5)) {
      console.log('    ' + (item.deltaFiles >= 0 ? '+' : '') + item.deltaFiles + ' | ' + item.path);
    }
  }
  console.log('\nInforme JSON: ' + result.outputPath);
  console.log('No se han modificado los archivos inspeccionados.');
}

async function runAllocated(args: string[]): Promise<void> {
  const metadata = await loadLatestMetadata();
  if (metadata.entries === 0) throw new Error('El índice está vacío; escanea primero una carpeta válida.');
  const outputPath = readOption(args, '--out');
  console.log('\nAnSysWarden · Espacio asignado (Windows, solo lectura)');
  console.log('────────────────────────────────────────');
  console.log('Escaneo:  ' + metadata.id);
  console.log('Archivos: ' + metadata.files.toLocaleString('es-ES'));
  console.log('Tamaño lógico del índice: ' + formatBytes(metadata.sizeBytes));
  const result = await measureAllocatedSpace(metadata, {
    ...(outputPath ? { outputPath } : {}),
    onProgress: (done, total) => {
      process.stdout.write('\rMedidos: ' + done.toLocaleString('es-ES') +
        ' / ' + total.toLocaleString('es-ES') + ' archivos   ');
    },
  });
  process.stdout.write('\n');
  console.log('Medidos correctamente: ' + result.summary.measuredFiles.toLocaleString('es-ES'));
  console.log('Fallos:               ' + result.summary.failedFiles.toLocaleString('es-ES'));
  console.log('Bytes asignados en archivos medidos: ' +
    result.summary.allocatedBytesMeasured.toLocaleString('es-ES'));
  console.log('Estado: ' + (result.summary.complete ? 'COMPLETO' : 'PARCIAL'));
  console.log('Resultado: ' + result.outputPath);
  console.log('No se han modificado los archivos inspeccionados.');
  console.log('Regenera el HTML con: ./ansys-tree html --out escritorio_espacio.html');
}

async function runAge(args: string[]): Promise<void> {
  const metadata = await loadLatestMetadata();
  if (metadata.entries === 0) throw new Error('El índice está vacío; ejecuta tree scan antes.');
  const days = readPositiveInt(args, '--days') ?? 180;
  const top = readPositiveInt(args, '--top') ?? 25;
  const outputPath = readOption(args, '--out');
  const result = await analyzeTreeAge(metadata, {
    days, top, ...(outputPath ? { outputPath } : {}),
  });
  console.log('\nAnSysWarden · Antigüedad (solo lectura)');
  console.log('────────────────────────────────────────');
  console.log('Escaneo: ' + result.report.createdAt);
  console.log('Umbral sin modificar: ' + days + ' días');
  console.log('Archivos sin cambios: ' + result.report.staleFiles.toLocaleString('es-ES'));
  console.log('Tamaño lógico: ' + result.report.staleLogicalBytes.toLocaleString('es-ES') + ' B');
  console.log('Fechas desconocidas: ' + result.report.undatedFiles);
  console.log('Fechas posteriores al escaneo: ' + result.report.futureDatedFiles);
  console.log('Informe: ' + result.outputPath);
  console.log('No implica desuso ni autorización para borrar.');
}

async function runActivity(args: string[]): Promise<void> {
  const metadata = await loadLatestMetadata();
  const days = readPositiveInt(args, '--days') ?? 180;
  const outputPath = readOption(args, '--out');
  const result = await analyzeTreeActivity(metadata, {
    days, ...(outputPath ? { outputPath } : {}),
  });
  console.log('\nAnSysWarden · Actividad y familias (solo lectura)');
  console.log('────────────────────────────────────────');
  console.log('Índice: ' + metadata.id);
  console.log('Fecha del índice: ' + metadata.createdAt);
  console.log('Umbral: ' + days + ' días sin cambios');
  console.log('Carpetas reconocidas: ' + result.report.candidatesFound.toLocaleString('es-ES'));
  console.log('Para revisar: ' + result.report.candidatesToReview.toLocaleString('es-ES'));
  for (const candidate of result.report.candidates.slice(0, 20)) {
    console.log('  [' + candidate.suggestion + '] ' + formatBytes(candidate.logicalBytes) +
      ' · ' + candidate.family + ' · ' + candidate.path);
  }
  console.log('Informe: ' + result.outputPath);
  console.log('REVISAR no autoriza borrar. No se han modificado archivos inspeccionados.');
  console.log('HTML: ./ansys-tree html --out escritorio_actividad.html');
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === 'scan') return runScan(args);
  if (command === 'show') return runShow(args);
  if (command === 'html') return runHtml(args);
  if (command === 'audit') return runAudit(args);
  if (command === 'allocated') return runAllocated(args);
  if (command === 'age') return runAge(args);
  if (command === 'activity') return runActivity(args);
  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Tree] ${message}`);
  process.exitCode = 1;
});
