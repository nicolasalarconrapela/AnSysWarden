import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, join, resolve } from 'node:path';
import type { TreeEntryRecord, TreeIndexRecord, TreeScanMetadata } from '../core/inventory/tree-types';
import { CreateInventorySnapshot } from '../dust/inventory-snapshot';
import { writeNativeTreeHtml } from './tree-html';
import { runTreeAudit } from './tree-audit';
import { measureAllocatedSpace } from './tree-allocation';
import { analyzeTreeAge } from './tree-age';
import { analyzeTreeActivity } from './tree-activity';
import { buildAiReview } from './ai-review';
import { saveAiReview } from './ai-review-html';

const treeHelp: Record<string, { description: string; args: string; options: string[]; example: string; warning: string }> = {
  "scan": {
    "description": "Crear una captura nueva (ruta antigua; se recomienda dust scan).",
    "args": "<ruta> [--out indice.jsonl] [--html [archivo.html]]",
    "options": [
      "<ruta>          Carpeta raíz (obligatoria)",
      "--out PATH      Índice JSONL de salida",
      "--html [PATH]   Crear HTML, ruta opcional"
    ],
    "example": "scan \"data/pc-tree-fixture\" --html inventario.html",
    "warning": "Alias de compatibilidad: para nuevos escaneos utiliza ./ansys dust scan."
  },
  "show": {
    "description": "Leer nombres y tamaños en la terminal, sin abrir HTML.",
    "args": "[ruta] [--depth N] [--files] [--index indice.jsonl]",
    "options": [
      "[ruta]          Limitar a carpeta específica",
      "--depth N       Niveles visibles (por defecto 3)",
      "--files         Incluir archivos",
      "--index PATH    Índice JSONL"
    ],
    "example": "show --depth 5 --files",
    "warning": "No realiza un nuevo escaneo."
  },
  "html": {
    "description": "Forma antigua de generar un visor HTML desde datos guardados.",
    "args": "[--latest | --scan-id ID | --index indice.jsonl] [--out archivo.html] [--allocation medicion.jsonl]",
    "options": [
      "--out PATH         Archivo HTML de salida",
      "--index PATH       Índice JSONL",
      "--scan-id ID       Identificador de captura",
      "--latest           Última captura disponible",
      "--allocation PATH  Medición de espacio asignado"
    ],
    "example": "html --latest --out visor.html",
    "warning": "Usa datos existentes; pueden estar desactualizados."
  },
  "audit": {
    "description": "Comprobar qué cambió desde la captura guardada.",
    "args": "[--branches A,B,C] [--out informe.json]",
    "options": [
      "--branches A,B,C  Carpetas a auditar",
      "--out PATH         Informe JSON"
    ],
    "example": "audit --branches ANDROID_Studio,OSS,AnSysWarden",
    "warning": "No consulta TreeSize; el contenido puede haber cambiado."
  },
  "allocated": {
    "description": "Medir cuánto espacio ocupan los archivos en Windows.",
    "args": "[--out medicion.jsonl]",
    "options": [
      "--out PATH  Informe JSONL de mediciones"
    ],
    "example": "allocated",
    "warning": "Windows solamente; los bytes no incluyen todos los metadatos NTFS."
  },
  "age": {
    "description": "Buscar archivos que llevan tiempo sin modificarse.",
    "args": "[--days N] [--top N] [--out informe.json]",
    "options": [
      "--days N     Días (por defecto 180; 1..36500)",
      "--top N      Destacados (por defecto 25; 1..200)",
      "--out PATH   Informe JSON"
    ],
    "example": "age --days 180 --top 25",
    "warning": "Antiguo no equivale a innecesario."
  },
  "view": {
    "description": "Crear un visor HTML de la captura guardada (recomendado).",
    "args": "[--latest | --scan-id ID | --index indice.jsonl | --scan ruta] [--out archivo.html]",
    "options": [
      "--latest        Abrir el escaneo más reciente",
      "--scan-id ID    Abrir una captura guardada por su identificador",
      "--index PATH    Abrir índice existente sin acceder al disco original",
      "--scan PATH     Solicitar nueva captura al motor Dust y visualizarla",
      "--no-allocated  Omitir medición física en --scan",
      "--out PATH      Archivo HTML de salida"
    ],
    "example": "view --latest --out visor.html",
    "warning": "Los datos del índice pueden estar desactualizados; el visor no autoriza borrados."
  },
  "export": {
    "description": "Guardar una copia HTML de una captura existente.",
    "args": "[--scan-id ID | --index PATH | --latest] [--format html] [--out PATH]",
    "options": [
      "--scan-id ID    Identificador de captura",
      "--index PATH    Índice existente",
      "--latest        Última captura",
      "--format html   Formato HTML (único disponible)",
      "--allocation PATH  Medición JSONL opcional",
      "--out PATH      Archivo de salida"
    ],
    "example": "export --latest --format html --out visor.html",
    "warning": "Leer una captura histórica no comprueba el estado actual del disco."
  },
  "ai-preview": {
    "description": "Revisar y aprobar localmente qué fichas Tree se prepararían para IA (sin enviar).",
    "args": "[--latest | --scan-id ID | --index PATH] [--limit N] [--out archivo.html]",
    "options": [
      "--latest        Usar la última captura guardada",
      "--scan-id ID    Elegir una captura anterior",
      "--index PATH    Elegir el índice JSONL guardado",
      "--limit N       Ver como máximo N carpetas (1..60; por defecto 60)",
      "--out PATH      Guardar la revisión HTML; sin sobrescribir archivos"
    ],
    "example": "ai-preview --latest --out revision_ia.html",
    "warning": "No envía información a la IA ni autoriza borrados. Si --out ya existe, se conserva: usa otro nombre."
  },
  "activity": {
    "description": "Reconocer grupos de archivos que conviene revisar.",
    "args": "[--days N] [--out informe.json]",
    "options": [
      "--days N     Días sin cambios (por defecto 180; 1..36500)",
      "--out PATH   Informe JSON"
    ],
    "example": "activity --days 180",
    "warning": "REVISAR no autoriza borrados."
  }
};

const treeCommandOrder = [
  'scan', 'view', 'show', 'export', 'html',
  'audit', 'allocated', 'age', 'activity', 'ai-preview',
] as const;

// La explicación debe distinguir COMPORTAMIENTO, no solo nombres parecidos.
// Este texto no participa en el escaneo ni cambia sus opciones.
const treeGuidance: Record<string, { when: string; does: string; doesNot: string; next: string }> = {
  scan: {
    when: 'No tienes inventario y quieres crear uno NUEVO desde una carpeta.',
    does: 'Recorre esa carpeta, guarda un índice y opcionalmente un HTML. Es el acceso antiguo a la captura Dust, sin medición física adicional.',
    doesNot: 'No recupera un inventario anterior ni borra los archivos. Para escaneos nuevos se recomienda «dust scan».',
    next: './ansys tree view --latest --out visor.html',
  },
  view: {
    when: 'Ya guardaste un inventario y quieres ENTENDERLO visualmente.',
    does: 'Genera un archivo HTML que puedes abrir en el navegador. Sin selector usa la captura más reciente; --scan-id elige otra.',
    doesNot: 'No vuelve a recorrer la carpeta si usas --latest, --scan-id o --index. OJO: --scan <ruta> SÍ hace una captura nueva.',
    next: 'Abre el archivo visor.html en el navegador; para texto usa «tree show».',
  },
  show: {
    when: 'Quieres ver los nombres y tamaños directamente EN LA TERMINAL.',
    does: 'Lee un índice guardado e imprime un árbol de carpetas. --files muestra también los archivos.',
    doesNot: 'No genera HTML, no crea inventarios nuevos ni elimina archivos.',
    next: './ansys tree view --latest --out visor.html',
  },
  export: {
    when: 'Quieres GUARDAR una página HTML de un inventario, por ejemplo para consultarla sin conexión.',
    does: 'Convierte datos guardados en un archivo HTML autónomo; el único formato de exportación disponible es HTML.',
    doesNot: 'No exporta carpetas ni archivos originales, y no hace una captura nueva. «view» también genera HTML.',
    next: 'Abre el HTML guardado; si solo quieres consultar la última captura, usa «tree view --latest».',
  },
  html: {
    when: 'Tienes un flujo ANTIGUO que usa el comando html.',
    does: 'Genera el mismo tipo de visor HTML que view/export a partir de un índice guardado.',
    doesNot: 'No añade información al índice y no hace un escaneo nuevo. Si estás empezando, elige «tree view».',
    next: './ansys tree view --latest --out visor.html',
  },
  audit: {
    when: 'Quieres comprobar si una carpeta CAMBIÓ desde el inventario guardado.',
    does: 'Compara la captura con los archivos actuales de las ramas que se auditan; guarda un informe.',
    doesNot: 'No es una lista de archivos para borrar; lee el disco actual y no actualiza automáticamente la captura.',
    next: 'Revisa el informe antes de tomar decisiones; para actualizar el inventario, usa «dust scan».',
  },
  allocated: {
    when: 'Necesitas conocer ESPACIO ASIGNADO, distinto del tamaño lógico del archivo.',
    does: 'En Windows intenta medir cuánto espacio está asignado a archivos del último índice; guarda los resultados.',
    doesNot: 'No indica cuántos bytes se pueden liberar, no mide todo el sistema de archivos ni está disponible en otros sistemas.',
    next: './ansys tree view --latest --out visor_espacio.html',
  },
  age: {
    when: 'Quieres saber cuáles llevan mucho tiempo SIN MODIFICARSE.',
    does: 'Analiza fechas de modificación guardadas en el índice y genera un informe con un umbral en días.',
    doesNot: 'No demuestra que nadie los use. Un archivo antiguo NO es necesariamente prescindible.',
    next: 'Revisa el informe de antigüedad; puedes usar «tree view --latest» para explorar su carpeta.',
  },
  'ai-preview': {
    when: 'Quieres COMPROBAR como persona qué fichas prepararemos antes de consultar a Gemma.',
    does: 'Lee el JSONL existente y crea un HTML local con selección manual y exportación anonimizada.',
    doesNot: 'No escanea archivos otra vez, no contacta con servidores ni envía nada al móvil. Aprobar no autoriza borrar.',
    next: 'Abre el HTML generado, marca carpetas y revisa el JSON que podrías exportar.',
  },
  activity: {
    when: 'Quieres detectar GRUPOS de archivos relacionados o que requieren revisión.',
    does: 'Analiza patrones en la captura y propone grupos para observar o revisar.',
    doesNot: 'No sabe con certeza qué archivos sobran y nunca autoriza borrarlos.',
    next: './ansys tree view --latest --out visor_actividad.html',
  },
};

function printHelpParagraph(value: string): void {
  const indent = '    ';
  const limit = Math.max(54, Math.min(process.stdout.columns || 84, 96));
  let line = indent;
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line === indent ? indent + word : line + ' ' + word;
    if (candidate.length > limit && line !== indent) {
      console.log(line);
      line = indent + word;
    } else {
      line = candidate;
    }
  }
  if (line !== indent) console.log(line);
}

function printHelp(command?: string): void {
  console.log('\nAnSysWarden · TREE · Guía de exploración');
  console.log('════════════════════════════════════════════════════════════');

  if (!command) {
    console.log('\n  ¿QUÉ NECESITAS HACER?');
    console.log('    Ver una captura con carpetas y tamaños:');
    console.log('      ./ansys tree view --latest --out visor.html');
    console.log('    Ver esa captura como texto en esta terminal:');
    console.log('      ./ansys tree show --files');
    console.log('    Revisar las fichas de Tree antes de preguntar a Gemma:');
    console.log('      ./ansys tree ai-preview --latest --out revision_ia.html');
    console.log('    Ver qué ha cambiado respecto a la captura:');
    console.log('      ./ansys tree audit');
    console.log('    ¿Todavía no tienes una captura? Créala primero:');
    console.log('      ./ansys dust scan "<ruta>" --no-allocated');

    console.log('\n  COMANDOS DE TREE · Explicados por su resultado');
    for (const key of treeCommandOrder) {
      console.log('    ' + key.padEnd(13) + treeHelp[key].description);
    }

    console.log('\n  DIFERENCIAS QUE CONVIENE RECORDAR');
    console.log('    dust scan    = recorre archivos y guarda datos NUEVOS.');
    console.log('    tree view    = crea un HTML a partir de datos GUARDADOS.');
    console.log('    tree show    = los enseña en la TERMINAL, sin HTML.');
    console.log('    tree export  = guarda una copia HTML; view también crea HTML.');
    console.log('    tree html    = nombre antiguo de la misma función de HTML.');
    console.log('    tree scan    = acceso antiguo para crear una captura.');
    console.log('    ai-preview   = revisar las fichas para IA SIN ENVIAR datos.');
    console.log('    IMPORTANTE: tree view --scan <ruta> SÍ vuelve a escanear.');

    console.log('\n  Si olvidas una opción:');
    console.log('    ./ansys tree view --help');
    console.log('  Alias de Tree: ./ansys-tree <comando>');
    console.log('  <ruta> significa «carpeta que quieres examinar».');
    console.log('  Ningún resultado de Tree autoriza eliminar archivos.\n');
    return;
  }

  const info = Object.prototype.hasOwnProperty.call(treeHelp, command) ? treeHelp[command] : undefined;
  if (!info) throw new Error('Comando desconocido: ' + command + '. Consulta ./ansys tree --help');
  const guide = treeGuidance[command];
  if (!guide) throw new Error('No existe una guía para el comando: ' + command);

  console.log('\n  COMANDO');
  console.log('    ./ansys tree ' + command);
  console.log('\n  ¿CUÁNDO ME CONVIENE?');
  printHelpParagraph(guide.when);
  console.log('\n  ¿QUÉ HACE?');
  printHelpParagraph(guide.does);
  console.log('\n  ¿QUÉ NO HACE?');
  printHelpParagraph(guide.doesNot);
  console.log('\n  CÓMO SE ESCRIBE');
  console.log('    ./ansys tree ' + command + ' ' + info.args);
  console.log('\n  OPCIONES · Una por línea');
  for (const item of info.options) console.log('    ' + item);
  console.log('\n  EJEMPLO QUE PUEDES ADAPTAR');
  console.log('    ./ansys tree ' + info.example);
  console.log('\n  ¿Y DESPUÉS?');
  printHelpParagraph(guide.next);
  console.log('\n  PRECAUCIÓN');
  printHelpParagraph(info.warning);
  console.log('\n  Si te pierdes: ./ansys tree --help\n');
}

function usage(): never {
  printHelp();
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
  if (!inputPath || inputPath.startsWith('--')) {
    console.error('[ERROR] Falta la carpeta raíz que deseas inventariar.');
    printHelp('scan');
    process.exitCode = 2;
    return;
  }

  const outputPath = readOption(args, '--out');
  const htmlOption = readOptionalPathOption(args, '--html');
  console.warn('! [WARN] tree scan es un alias antiguo; usa dust scan para nuevas capturas.');
  const startedAt = Date.now();

  console.log('\nAnSysWarden · Tree Scan');
  console.log('────────────────────────────────────────');
  console.log(`Ruta:       ${inputPath}`);
  console.log('Modo:       scanner nativo completo');
  console.log('Incluye:    carpetas + archivos + tamaños + fechas + errores');
  console.log('Escritura:  índice JSONL incremental');
  console.log(`HTML:       ${htmlOption === null ? 'no' : 'sí'}`);

  const snapshot = await new CreateInventorySnapshot().execute(inputPath, {
    allocated: false, // Mantener coste y semántica histórica del comando tree scan.
    ...(outputPath ? { outputPath } : {}),
    onProgress: (progress) => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      process.stdout.write(`\rEscaneando... ${progress.entries.toLocaleString('es-ES')} entradas · ${progress.files.toLocaleString('es-ES')} archivos · ${progress.directories.toLocaleString('es-ES')} carpetas · ${elapsed}s   `);
    },
  });

  process.stdout.write('\n');
  const result = snapshot.metadata;
  snapshot.warnings.filter(warning => !warning.startsWith('Espacio asignado omitido'))
    .forEach(warning => console.warn('! [WARN] ' + warning));

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

/**
 * Resuelve los metadatos del índice explícitamente seleccionado.
 * Evita mostrar un índice antiguo con el latest.json de otro escaneo.
 * No modifica el índice ni el estado latest.
 */
async function loadMetadataForIndex(inputIndex: string): Promise<TreeScanMetadata> {
  const indexPath = resolve(inputIndex);
  if (!(await isFile(indexPath))) {
    throw new Error('No existe el índice solicitado: ' + indexPath);
  }

  const scansDir = resolve('.ansyswarden', 'tree', 'scans');
  const files = await readdir(scansDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  for (const name of files.filter(name => name.endsWith('.meta.json'))) {
    let metadata: TreeScanMetadata;
    try {
      metadata = JSON.parse(await readFile(join(scansDir, name), 'utf8')) as TreeScanMetadata;
    } catch {
      continue;
    }
    const storedPath = typeof metadata.indexPath === 'string' ? resolve(metadata.indexPath) : '';
    const canonicalPath = typeof metadata.id === 'string' ? resolve(scansDir, metadata.id + '.jsonl') : '';
    if (indexPath !== storedPath && indexPath !== canonicalPath) continue;
    if (metadata.schema !== 'ansyswarden.tree-index.v1'
      || !metadata.id || !metadata.rootPath || metadata.entries <= 0) {
      throw new Error('Metadatos incompatibles o incompletos para ' + indexPath);
    }
    return { ...metadata, indexPath };
  }

  throw new Error(
    'No se encontraron metadatos verificables del índice: ' + indexPath + '\\n' +
    'Utiliza un índice generado por AnSysWarden y conserva su archivo .meta.json.'
  );
}

async function runHtml(args: string[]): Promise<void> {
  const requestedIndex = readOption(args, '--index');
  const scanId = readOption(args, '--scan-id');
  const latest = args.includes('--latest');
  if (Number(Boolean(requestedIndex)) + Number(Boolean(scanId)) + Number(latest) > 1) {
    throw new Error('Utiliza solamente --index, --scan-id o --latest.');
  }
  if (args.includes('--scan-id') && (!scanId || scanId.startsWith('--'))) {
    throw new Error('--scan-id necesita un identificador.');
  }
  if (scanId && !/^tree-[0-9]{14}-[0-9a-f]{8}$/i.test(scanId)) {
    throw new Error('Identificador de inventario inválido: ' + scanId);
  }
  const idIndex = scanId ? join(resolve('.ansyswarden', 'tree', 'scans'), scanId + '.jsonl') : undefined;
  const metadata = requestedIndex ? await loadMetadataForIndex(requestedIndex)
    : idIndex ? await loadMetadataForIndex(idIndex)
    : await loadLatestMetadata();
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

async function runView(args: string[]): Promise<void> {
  const scanPath = readOption(args, '--scan');
  if (args.includes('--scan')) {
    if (!scanPath || scanPath.startsWith('--')) throw new Error('--scan necesita una carpeta.');
    if (args.includes('--index') || args.includes('--scan-id') || args.includes('--latest')) {
      throw new Error('Utiliza --scan, --index, --scan-id o --latest, nunca varios juntos.');
    }
    const snapshot = await new CreateInventorySnapshot().execute(scanPath, {
      allocated: !args.includes('--no-allocated'),
    });
    const { metadata, manifest, manifestPath } = snapshot;
    const outputPath = resolve(readOption(args, '--out') ?? metadata.id + '.html');
    const html = await writeNativeTreeHtml({
      metadata,
      indexPath: metadata.indexPath,
      outputPath,
    });
    console.log((manifest.status === 'COMPLETE' ? '✓ [PASS]' : '! [WARN]') +
      ' Inventario nuevo: ' + metadata.indexPath);
    console.log('Manifiesto: ' + manifestPath);
    console.log('Tree HTML: ' + html);
    console.log('Entradas: ' + metadata.entries + ' · Errores: ' + metadata.errors);
    snapshot.warnings.forEach(warning => console.warn('! [WARN] ' + warning));
    return;
  }
  if (args.includes('--no-allocated')) {
    throw new Error('--no-allocated solo puede utilizarse con --scan.');
  }
  return runHtml(args);
}

async function runAiPreview(args: string[]): Promise<void> {
  const optionsWithValue = new Set(['--scan-id', '--index', '--limit', '--out']);
  let selectorCount = 0;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--latest') {
      selectorCount++;
      continue;
    }
    if (!optionsWithValue.has(option)) {
      throw new Error('Opción desconocida de ai-preview: ' + option);
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) {
      throw new Error('Falta el valor de ' + option);
    }
    if (option === '--scan-id' || option === '--index') selectorCount++;
  }
  if (selectorCount > 1) throw new Error('Elige un solo índice con --latest, --scan-id o --index.');

  const scanId = readOption(args, '--scan-id');
  if (scanId && !/^tree-[0-9]{14}-[0-9a-f]{8}$/i.test(scanId)) {
    throw new Error('Identificador de captura inválido.');
  }
  const inputIndex = readOption(args, '--index');
  const idIndex = scanId ? join(resolve('.ansyswarden', 'tree', 'scans'), scanId + '.jsonl') : undefined;
  const metadata = inputIndex ? await loadMetadataForIndex(inputIndex)
    : idIndex ? await loadMetadataForIndex(idIndex) : await loadLatestMetadata();
  const rawLimit = readOption(args, '--limit');
  const limit = rawLimit === undefined ? 60 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) {
    throw new Error('--limit debe ser un entero entre 1 y 60.');
  }

  // No se invoca el escáner ni el backend: solo el índice ya persistido.
  const review = await buildAiReview(metadata, limit);
  const output = readOption(args, '--out') ?? ('revision_ia_' + metadata.id + '.html');
  const saved = await saveAiReview(review, output);
  console.log('\nAnSysWarden · Revisión humana antes de IA');
  console.log('────────────────────────────────────────');
  console.log('Captura:    ' + review.scanId);
  console.log('Carpetas:   ' + review.totalDirectories);
  console.log('Mostradas:  ' + review.shown);
  console.log('Omitidas:   ' + review.omitted + ' (límite visual; no supone ausencia)');
  console.log('Revisables: ' + review.folders.filter(folder => folder.eligible).length);
  console.log('Errores:    ' + review.errors);
  console.log('HTML local: ' + saved.htmlPath);
  console.log('Mapa privado del PC: ' + saved.privateMapPath);
  console.log('Abre el HTML para elegir carpetas y comprobar el JSON.');
  console.log('No se ha contactado con IA ni se ha enviado o borrado ningún archivo.');
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    printHelp(command === 'help' && args[0] && !['--help', '-h'].includes(args[0]) ? args[0] : undefined);
    return;
  }
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    printHelp(command);
    return;
  }
  if (command === 'scan') return runScan(args);
  if (command === 'show') return runShow(args);
  if (command === 'html') return runHtml(args);
  if (command === 'view') return runView(args);
  if (command === 'export') {
    const format = readOption(args, '--format') ?? 'html';
    if (format !== 'html') throw new Error('Tree export solo admite --format html.');
    return runHtml(args);
  }
  if (command === 'audit') return runAudit(args);
  if (command === 'allocated') return runAllocated(args);
  if (command === 'age') return runAge(args);
  if (command === 'activity') return runActivity(args);
  if (command === 'ai-preview') return runAiPreview(args);
  usage();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AnSysWarden Tree] ${message}`);
  process.exitCode = 1;
});
