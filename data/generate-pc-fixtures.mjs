#!/usr/bin/env node
/**
 * AnSysWarden PC · fixture reproducible para Tree / HTML / Audit.
 *
 * node data/generate-pc-fixtures.mjs
 * node data/generate-pc-fixtures.mjs --verify
 * node data/generate-pc-fixtures.mjs --verify --index .ansyswarden/tree/scans/<id>.jsonl
 *
 * Solo escribe en data/pc-tree-fixture. Nunca borra ni sobrescribe archivos
 * existentes con contenido distinto. No crea enlaces ni ejecuta comandos.
 */
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, 'pc-tree-fixture');
const args = process.argv.slice(2);
const useColor = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb');
const palette = {
  green: value => useColor ? '\u001b[32m' + value + '\u001b[0m' : value,
  red: value => useColor ? '\u001b[31m' + value + '\u001b[0m' : value,
  yellow: value => useColor ? '\u001b[33m' + value + '\u001b[0m' : value,
  cyan: value => useColor ? '\u001b[36m' + value + '\u001b[0m' : value,
};
const resultLine = (level, message) => {
  const prefix = level === 'PASS' ? palette.green('✓ [PASS]')
    : level === 'FAIL' ? palette.red('✗ [FAIL]')
    : level === 'WARN' ? palette.yellow('! [WARN]')
    : palette.cyan('ℹ [INFO]');
  const output = level === 'FAIL' ? console.error : console.log;
  output(prefix + ' ' + message);
};

const verifyOnly = args.includes('--verify');
const indexPosition = args.indexOf('--index');
const indexFile = indexPosition >= 0 ? args[indexPosition + 1] : undefined;
const readme = `AnSysWarden · PC test fixture
================================
Datos completamente ficticios. No hay documentación, fotos ni bases de datos reales.
Este árbol permite validar escaneo, HTML, recuentos, tamaños y clasificación.
No debe utilizarse para autorizar eliminaciones.
`;

const text = (value) => Buffer.from(value, 'utf8');
const fakeBytes = (bytes, first = 65) => {
  const result = Buffer.alloc(bytes, 0x30);
  if (bytes > 0) result[0] = first;
  return result;
};

const FILES = new Map([
  ['LEEME.txt', text(readme)],
  ['proyecto-web/package.json', text('{"name":"fixture-web","private":true,"scripts":{"build":"echo fake"}}\n')],
  ['proyecto-web/package-lock.json', text('{"name":"fixture-web","lockfileVersion":3,"packages":{}}\n')],
  ['proyecto-web/src/index.ts', text('export const ejemplo = "código de prueba";\n')],
  ['proyecto-web/src/componente.test.ts', text('export const resultado = true;\n')],
  ['proyecto-web/node_modules/.package-lock.json', text('{"name":"fixture-node-modules","lockfileVersion":3}\n')],
  ['proyecto-web/node_modules/ejemplo/index.js', text('module.exports = "dependencia ficticia";\n')],
  ['proyecto-web/build/salida.bin', fakeBytes(4096)],
  ['proyecto-web/build/KEEP-important.txt', text('No borrar automáticamente: marcador de protección ficticio.\n')],
  ['proyecto-java/build/classes/App.class', fakeBytes(2048, 0xca)],
  ['proyecto-java/.gradle/caches/cache.bin', fakeBytes(8192)],
  ['documentos/contrato-importante.txt', text('DOCUMENTO FICTICIO: nunca tratar como caché.\n')],
  ['fotos/vacaciones 2024/foto-simulada.txt', text('Marcador de foto; no es una imagen real.\n')],
  ['backups/copia-única.txt', text('BACKUP FICTICIO: contenido único de prueba.\n')],
  ['ambiguos/cache-KEEP-important/nota.txt', text('Carpeta ambigua protegida por KEEP.\n')],
  ['temporales/vacio.txt', Buffer.alloc(0)],
  ['temporales/espacios y ñ.txt', text('Nombres Unicode y espacios.\n')],
  ['temporales/con.puntos.y.mayusculas.TXT', text('Extensión y nombres especiales.\n')],
  ['datos/unico.csv', text('id,descripcion\n1,registro irrepetible ficticio\n')],
]);

const EMPTY_DIRS = ['carpeta-vacia', 'proyecto-web/docs/vacio'];
const asRelative = path => relative(root, path).replaceAll('\\', '/');
const rootPath = () => root;

async function existingFilesAndDirectories() {
  const files = new Map();
  const dirs = new Set(['']);
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = asRelative(path);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error('Enlace inesperado: ' + key);
      if (stats.isDirectory()) {
        dirs.add(key);
        await walk(path);
      } else if (stats.isFile()) {
        files.set(key, stats.size);
      } else throw new Error('Tipo especial inesperado: ' + key);
    }
  }
  await walk(root);
  return { files, dirs };
}

function expectedDirectories() {
  const dirs = new Set(['', ...EMPTY_DIRS]);
  for (const path of FILES.keys()) {
    const pieces = path.split('/');
    for (let i = 1; i < pieces.length; i++) dirs.add(pieces.slice(0, i).join('/'));
  }
  for (const path of EMPTY_DIRS) {
    const pieces = path.split('/');
    for (let i = 1; i < pieces.length; i++) dirs.add(pieces.slice(0, i).join('/'));
  }
  return dirs;
}

function expectedTotal() {
  return [...FILES.values()].reduce((sum, content) => sum + content.length, 0);
}

async function verifyFixture() {
  const actual = await existingFilesAndDirectories();
  const expectedDirs = expectedDirectories();
  const diffs = [];
  for (const [path, content] of FILES) {
    const length = actual.files.get(path);
    if (length !== content.length) diffs.push('Tamaño o fichero incorrecto: ' + path);
    else {
      const actualContent = await readFile(join(root, path));
      if (!actualContent.equals(content)) diffs.push('Contenido diferente: ' + path);
    }
  }
  for (const path of actual.files.keys()) if (!FILES.has(path)) diffs.push('Archivo inesperado: ' + path);
  for (const path of expectedDirs) if (!actual.dirs.has(path)) diffs.push('Carpeta ausente: ' + path);
  for (const path of actual.dirs) if (!expectedDirs.has(path)) diffs.push('Carpeta inesperada: ' + path);

  const bytes = [...actual.files.values()].reduce((sum, value) => sum + value, 0);
  if (bytes !== expectedTotal()) diffs.push('Bytes diferentes: ' + bytes);
  const expected = { files: FILES.size, directories: expectedDirs.size, entries: FILES.size + expectedDirs.size, sizeBytes: expectedTotal() };
  if (diffs.length) {
    diffs.forEach(message => resultLine('FAIL', message));
    throw new Error('Fixture no coincide con los valores esperados');
  }
  resultLine('PASS', 'Fixture: ' + expected.files + ' archivos · ' + expected.directories + ' carpetas · ' + expected.sizeBytes + ' bytes');
  return expected;
}

async function verifyTreeIndex(path, expected) {
  const absolute = resolve(path);
  const records = createInterface({ input: createReadStream(absolute), crlfDelay: Infinity });
  const entries = [];
  const summaries = [];
  const errors = [];
  for await (const line of records) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (value.record === 'entry') entries.push(value);
    else if (value.record === 'directory-summary') summaries.push(value);
    else if (value.record === 'error') errors.push(value);
  }
  const files = entries.filter(x => x.type === 'file');
  const dirs = entries.filter(x => x.type === 'directory');
  const indexPaths = new Set(entries.map(x => resolve(x.path)));
  const expectedPaths = [root, ...FILES.keys()].map(x => x === root ? x : join(root, x));
  for (const folder of expectedDirectories()) if (folder) expectedPaths.push(join(root, folder));
  const missing = expectedPaths.filter(p => !indexPaths.has(resolve(p)));
  const rootSummary = summaries.find(x => resolve(x.path) === root);
  const issues = [];
  if (entries.length !== expected.entries) issues.push('Entradas: ' + entries.length + ' != ' + expected.entries);
  if (files.length !== expected.files) issues.push('Archivos: ' + files.length + ' != ' + expected.files);
  if (dirs.length !== expected.directories) issues.push('Directorios: ' + dirs.length + ' != ' + expected.directories);
  if (errors.length !== 0) issues.push('Errores del índice: ' + errors.length);
  if (missing.length) issues.push('Rutas ausentes: ' + missing.slice(0, 8).join(', '));
  if (!rootSummary || rootSummary.sizeBytes !== expected.sizeBytes) issues.push('Tamaño del resumen raíz incorrecto');
  if (issues.length) {
    issues.forEach(message => resultLine('FAIL', message));
    throw new Error('El índice Tree no coincide con la fixture');
  }
  resultLine('PASS', 'Índice Tree: entradas, rutas, recuentos y bytes correctos');
}

async function generate() {
  await mkdir(root, { recursive: true });
  for (const folder of expectedDirectories()) if (folder) await mkdir(join(root, folder), { recursive: true });
  for (const [name, content] of FILES) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const before = await readFile(path);
      if (!before.equals(content)) throw new Error('Ya existe con contenido distinto: ' + path);
    }
  }
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node data/generate-pc-fixtures.mjs [--verify] [--index indice.jsonl]');
    console.log('Directorio fijo y seguro: ' + rootPath());
    return;
  }
  if (indexPosition >= 0 && (!indexFile || indexFile.startsWith('--'))) throw new Error('--index necesita una ruta');
  if (!verifyOnly) await generate();
  const expected = await verifyFixture();
  if (indexFile) await verifyTreeIndex(indexFile, expected);
  resultLine('INFO', 'Ruta para Tree: ' + rootPath());
  resultLine('INFO', 'Ejemplo: ./ansys tree scan "data/pc-tree-fixture" --html prueba.html');
  resultLine('WARN', 'Solo datos ficticios: no autoriza borrados ni accede a archivos personales.');
}

main().catch(error => { resultLine('FAIL', error.message); process.exitCode = 1; });
