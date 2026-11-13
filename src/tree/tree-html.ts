import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import type { TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';
import { ALLOCATION_SCHEMA, defaultAllocationPath, type AllocatedFileRecord, type AllocationSummary } from './tree-allocation';
import { defaultActivityPath, TREE_ACTIVITY_SCHEMA, type ActivityReport } from './tree-activity';

interface TreeHtmlOptions {
  indexPath: string;
  outputPath: string;
  metadata: TreeScanMetadata;
  allocationPath?: string;
}

// Tuplas compactas [padre, tipo, nombre, bytes, mtime, ocupado, birthtime, atime].
// El navegador solo crea elementos DOM para las filas visibles (paginadas).
// El HTML es autónomo: abre directamente con file:// sin servidor ni CDN.
export async function writeNativeTreeHtml(options: TreeHtmlOptions): Promise<string> {
  const indexPath = resolve(options.indexPath);
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });

  // Las mediciones se guardan fuera del índice original.
  const allocationPath = resolve(options.allocationPath ?? defaultAllocationPath(options.metadata));
  const allocations = new Map<string, number | null>();
  let allocationSummary: AllocationSummary | null = null;
  try {
    await access(allocationPath);
    let validHeader = false;
    await readIndex(allocationPath, record => {
      const value = record as unknown as AllocatedFileRecord | AllocationSummary |
        { record: 'header'; schema: string; sourceScanId: string };
      if (value.record === 'header') {
        validHeader = value.schema === ALLOCATION_SCHEMA &&
          value.sourceScanId === options.metadata.id;
        if (!validHeader) throw new Error('Las mediciones pertenecen a otro escaneo.');
      }
      if (!validHeader) return;
      if (value.record === 'file') allocations.set(value.path, value.allocatedBytes);
      if (value.record === 'summary') allocationSummary = value;
    });
    if (!allocationSummary || (allocationSummary as AllocationSummary).sourceScanId !== options.metadata.id ||
        allocations.size !== options.metadata.files) {
      throw new Error('El archivo de mediciones está incompleto.');
    }
  } catch (error) {
    if (options.allocationPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let activityReport: ActivityReport | null = null;
  const activityPath = defaultActivityPath(options.metadata);
  try {
    const parsed = JSON.parse(await readFile(activityPath, 'utf8')) as ActivityReport;
    if (parsed.schema === TREE_ACTIVITY_SCHEMA && parsed.scanId === options.metadata.id &&
        Array.isArray(parsed.candidates)) {
      activityReport = parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const summaries = new Map<string, number>();
  await readIndex(indexPath, record => {
    if (record.record === 'directory-summary') summaries.set(record.path, record.sizeBytes);
  });

  // Nunca dejar un HTML incompleto como si estuviera listo.
  const tempPath = outputPath + '.tmp-' + process.pid;
  const output = createWriteStream(tempPath, { encoding: 'utf8', flags: 'w' });
  const write = async (text: string): Promise<void> => {
    if (!output.write(text)) await once(output, 'drain');
  };

  try {
    await write(String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AnSysWarden · Tree</title>
<style>
:root{color-scheme:dark;--bg:#171717;--panel:#151515;--line:#303030;--text:#f3f3f3;--muted:#aaa;--bar:#555;--bar0:#686868;--link:#8ec5ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:14px 18px}
.title{font-size:19px;font-weight:700}.meta,.summary{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted)}.meta{margin-top:4px}
.summary{padding:9px 18px;background:#1b1b1b;border-bottom:1px solid var(--line)}.summary strong{color:var(--text)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.toolbar input,.toolbar select,.toolbar button{background:#222;color:var(--text);border:1px solid #3b3b3b;border-radius:5px;padding:7px 9px}
.toolbar input{min-width:280px;flex:1}.toolbar button{cursor:pointer}.unit-label{align-self:center;color:var(--muted)}.toolbar button:hover{border-color:#777}
.tree{width:100%;overflow:auto}.columns-header{display:grid;grid-template-columns:minmax(0,1fr) 150px 150px 150px 150px 150px 80px;min-width:1370px;padding:6px 12px;color:var(--muted);font-size:12px;background:#202020;gap:0}.columns-header span:not(:first-child){text-align:right;padding-right:12px}.row{position:relative;display:flex;align-items:center;min-height:28px;white-space:nowrap;overflow:hidden}
.row:hover{background:#262626}.bar{position:absolute;top:1px;bottom:1px;background:var(--bar);opacity:.82;pointer-events:none}
.content{position:relative;z-index:2;display:grid;grid-template-columns:minmax(0,1fr) 150px 150px 150px 150px 150px 80px;align-items:center;width:100%;min-width:1370px;padding:3px 12px;gap:0}.treecell{display:flex;align-items:center;min-width:0;overflow:hidden}
.toggle{width:18px;border:0;background:transparent;color:#ddd;cursor:pointer;padding:0;font-size:15px;line-height:1;flex-shrink:0}
.toggle.empty{visibility:hidden}.icon{width:22px;text-align:center;margin-right:4px;flex-shrink:0}
.size{display:block;width:150px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap;padding-right:12px}.size.size-indented{text-align:left;padding-left:var(--size-offset,0px);padding-right:0}.allocated{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right;padding-right:12px;font-weight:600;color:#b9d7e6}.allocated.unknown{color:var(--muted)}.modified,.created,.accessed{font-size:12px;color:#b7bcc8;text-align:right;white-space:nowrap;padding-right:12px;font-variant-numeric:tabular-nums}.artifact-label{margin-left:8px;padding:1px 5px;border:1px solid #626b78;border-radius:4px;font-size:11px;white-space:nowrap;color:#d9e1f0}.artifact-label.review{border-color:#ad8b40;color:#f8d18b}.file-count{color:#c9d1da;font-size:12px;white-space:nowrap;margin-left:7px;flex-shrink:0}.file-count.zero{color:var(--muted)}
.name{overflow:hidden;text-overflow:ellipsis;min-width:0}.name-link{color:var(--link);text-decoration:none;overflow:hidden;text-overflow:ellipsis;min-width:0}
.name-link:hover{text-decoration:underline;text-underline-offset:2px}.kind{color:var(--muted);font-size:11px;text-align:right;padding-left:10px}
.error{color:#ff9898}.row.error{background:rgba(245,109,109,.075)}.row.error:hover{background:rgba(245,109,109,.12)}
:root{--ok:#9bd7ae;--warn:#f1cc87;--bad:#ff9898;--info:#a9c8e9}
.legend{display:flex;flex-wrap:wrap;align-items:center;gap:16px;padding:8px 18px;border-bottom:1px solid var(--line);background:#1b1b1b;color:#bcbcbc;font-size:12px}
.legend strong{font-weight:600;color:#e5e5e5}.legend .ok{color:var(--ok)}.legend .review{color:var(--warn)}.legend .problem{color:var(--bad)}.legend .neutral{color:var(--info)}
.state-review{color:var(--warn)!important}.state-problem{color:var(--bad)!important}.state-ok{color:var(--ok)!important}
.artifact-label{font-weight:650;letter-spacing:.015em}.artifact-label.review{border-color:#ac8c50;color:var(--warn);background:rgba(172,140,80,.095)}
.artifact-label:not(.review){border-color:#5f7787;color:var(--info);background:rgba(100,140,170,.075)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
.foot{position:sticky;bottom:0;background:#1c1c1c;border-top:1px solid var(--line);padding:7px 18px;display:flex;align-items:center;gap:12px}
.foot button{background:#303030;color:var(--text);border:1px solid #555;border-radius:4px;padding:5px 12px;cursor:pointer}
#status{color:var(--muted)}.empty-state{padding:30px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<header>
  <div class="title">AnSysWarden · Tree</div>
  <div class="meta"><span id="root"></span><span id="computer"></span><span>Scanner: native</span></div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Buscar archivo, carpeta o ruta…" autocomplete="off">
    <select id="typeFilter">
      <option value="all">Todo</option><option value="directory">Carpetas</option>
      <option value="file">Archivos</option><option value="symlink">Enlaces</option><option value="error">Errores</option>
    </select>
    <select id="activityFilter" aria-label="Filtrar familias de artefactos">
      <option value="all">Actividad: todas</option>
      <option value="detected">Familias detectadas</option>
      <option value="review">Familias para revisar</option>
    </select>
    <button id="expand3" type="button">Expandir 3 niveles</button>
    <button id="collapse" type="button">Colapsar todo</button>
    <button id="sizeIndent" type="button" aria-pressed="false" title="Alternar entre tamaños alineados e indentados por profundidad">Indentar tamaños: No</button>
    <label for="unitMode" class="unit-label">Unidad</label>
    <select id="unitMode" aria-label="Unidad para los tamaños">
      <option value="binary">Automática (base 1024)</option>
      <option value="decimal">Automática (base 1000)</option>
      <option value="GiB">GiB</option>
      <option value="GB">GB</option>
      <option value="bytes">Bytes</option>
    </select>
  </div>
</header>
<div class="summary">
  <span>Entradas: <strong id="entries"></strong></span>
  <span>Archivos: <strong id="files"></strong></span>
  <span>Carpetas: <strong id="directories"></strong></span>
  <span>Tamaño lógico: <strong id="totalSize"></strong></span>
  <span>GB (decimal): <strong id="decimalTotal"></strong></span>
  <span>GiB (binario): <strong id="binaryTotal"></strong></span>
  <span>Bytes exactos: <strong id="exactTotal"></strong></span>
  <span>Ocupado en archivos medidos: <strong id="allocatedTotal">No disponible (no medido)</strong></span>
  <span>Medición física: <strong id="allocationStatus">No disponible</strong></span>
  <span>Familias detectadas: <strong id="artifactCount">Sin analizar</strong></span>
  <span>Para revisar: <strong id="artifactReview" class="state-review">—</strong></span>
  <span>Errores: <strong id="errors"></strong></span>
</div>
<div class="legend" role="note" aria-label="Leyenda de estados de análisis">
  <strong>Leyenda</strong>
  <span class="ok">✓ Correcto: comprobación completada</span>
  <span class="review">! Revisar: requiere comprobación humana</span>
  <span class="problem">✗ Error: índice o medición incompleta</span>
  <span class="neutral">ℹ Observar: información orientativa</span>
  <span>Los colores no autorizan eliminaciones.</span>
</div>
<main><div class="tree"><div class="columns-header"><span>Nombre (archivos)</span><span>Tamaño lógico</span><span>Ocupado en archivos</span><span>Última modificación</span><span>Creación</span><span>Último acceso registrado</span><span>Tipo</span></div><div id="rows"><div class="empty-state">Preparando árbol…</div></div></div></main>
<div class="foot">
  <span id="status" role="status">Preparando índice…</span>
  <button id="more" type="button" hidden>Mostrar 400 más</button>
</div>
<script id="payload" type="application/json">{"metadata":` + safeScriptJson(options.metadata) + String.raw`,"nodes":[`);
    const branch: number[] = [];
    const directoryIds = new Map<string, number>();
    let count = 0;
    let first = true;

    await readIndex(indexPath, async record => {
      if (record.record === 'directory-summary') return;

      if (record.record === 'entry') {
        const parentId = record.depth === 0 ? -1 : branch[record.depth - 1] ?? -1;
        const type = record.type === 'directory' ? 0 : record.type === 'file' ? 1 : record.type === 'symlink' ? 2 : 3;
        const size = type === 0 ? summaries.get(record.path) ?? 0 : record.sizeBytes;
        const row = [parentId, type, record.name, size, record.mtimeMs,
          type === 1 ? (allocations.get(record.path) ?? null) : null,
          record.birthtimeMs ?? null, record.atimeMs ?? null];
        if (!first) await write(',');
        await write(safeScriptJson(row));
        first = false;
        branch.length = record.depth + 1;
        branch[record.depth] = count;
        if (type === 0) directoryIds.set(record.path, count);
        count++;
        return;
      }

      if (record.record === 'error') {
        // Los errores se muestran como hijos del directorio afectado, si existe.
        const parentId = directoryIds.get(record.path)
          ?? (record.parentPath ? directoryIds.get(record.parentPath) : undefined) ?? -1;
        const row = [parentId, 4, record.name + ' · ' + (record.code ?? 'ERROR'), 0, 0];
        if (!first) await write(',');
        await write(safeScriptJson(row));
        first = false;
        count++;
      }
    });

    const activityView = activityReport ? {
      thresholdDays: activityReport.thresholdDays,
      candidates: activityReport.candidates
        .filter(candidate => directoryIds.has(candidate.path))
        .map(candidate => ({
          id: directoryIds.get(candidate.path),
          family: candidate.family,
          activity: candidate.activity,
          status: candidate.suggestion,
          evidence: candidate.evidence,
          reason: candidate.reason,
          confidence: candidate.confidence,
        })),
    } : null;
    await write(String.raw`]}</script>
<script id="activityMetadata" type="application/json">` +
      safeScriptJson(activityView) + String.raw`</script>
<script id="allocationMetadata" type="application/json">` +
      safeScriptJson(allocationSummary) + String.raw`</script>
<script>
(() => {
  'use strict';
  const rowsHost = document.getElementById('rows');
  const status = document.getElementById('status');
  const more = document.getElementById('more');
  const search = document.getElementById('search');
  const filter = document.getElementById('typeFilter');
  const activityFilter = document.getElementById('activityFilter');
  const expand3 = document.getElementById('expand3');
  const collapse = document.getElementById('collapse');
  const sizeIndent = document.getElementById('sizeIndent');
  const unitMode = document.getElementById('unitMode');
  let indentSizes = false;
  let sizeUnit = 'binary';
  const PAGE_SIZE = 400;
  let limit = PAGE_SIZE;
  let mask = null;
  let filtering = false;
  const expanded = new Set();
  const collapsed = new Set();
  const sorted = new Map();
  const names = ['directory','file','symlink','other','error','file-group'];
  const icons = ['📁','📄','↗','•','⚠','📄'];

  let payload;
  try {
    payload = JSON.parse(document.getElementById('payload').textContent);
  } catch (error) {
    rowsHost.textContent = 'No se pudo interpretar el índice: ' + String(error);
    status.textContent = 'Error en los datos del visor';
    return;
  }
  const metadata = payload.metadata;
  const nodes = payload.nodes;
  const allocation = JSON.parse(document.getElementById('allocationMetadata').textContent);
  const activityData = JSON.parse(document.getElementById('activityMetadata').textContent);
  document.getElementById('activityMetadata').remove();
  const activityByPath = new Map();
  const activityKey = value => String(value).replaceAll(String.fromCharCode(92), '/').toLowerCase();
  if (activityData) {
    for (const candidate of activityData.candidates) activityByPath.set(activityKey(candidate.path), candidate);
    document.getElementById('artifactCount').textContent = activityData.candidates.length.toLocaleString('es-ES');
    document.getElementById('artifactReview').textContent =
      activityData.candidates.filter(c => c.suggestion === 'REVISAR').length.toLocaleString('es-ES');
  }
  document.getElementById('allocationMetadata').remove();
  document.getElementById('payload').remove();
  // Fecha más reciente conocida del contenido de cada carpeta.
  // No representa necesariamente la fecha de último uso.
  const latestChange = new Float64Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const modified = nodes[i][4];
    if (Number.isFinite(modified) && modified > 0) latestChange[i] = modified;
    const p = nodes[i][0];
    if (p >= 0 && latestChange[i] > latestChange[p]) latestChange[p] = latestChange[i];
  }
  const allocatedTotals = new Float64Array(nodes.length);
  const missingAllocated = new Uint32Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i][1] === 1) {
      if (typeof nodes[i][5] === 'number' && Number.isFinite(nodes[i][5]))
        allocatedTotals[i] = nodes[i][5];
      else missingAllocated[i] = 1;
    }
    const p = nodes[i][0];
    if (p >= 0) {
      allocatedTotals[p] += allocatedTotals[i];
      missingAllocated[p] += missingAllocated[i];
    }
  }

  const children = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const parentId = nodes[i][0];
    let siblings = children.get(parentId);
    if (!siblings) { siblings = []; children.set(parentId, siblings); }
    siblings.push(i);
  }
  // Agrupación exclusiva de presentación: los archivos siguen estando en
  // el índice original. Se crea un único nodo virtual por carpeta con archivos
  // directos y su tamaño es la suma de esos archivos, no espacio adicional.
  // Conteo recursivo exacto del índice para cada directorio físico.
  // El índice se emitió en preorden, de modo que la acumulación inversa
  // agrega cada archivo una sola vez al padre sin recorrer descendientes.
  const originalNodeCount = nodes.length;
  const fileCounts = new Float64Array(originalNodeCount);
  for (let i = originalNodeCount - 1; i >= 0; i--) {
    if (nodes[i][1] === 1) fileCounts[i] = 1;
    const parent = nodes[i][0];
    if (parent >= 0) fileCounts[parent] += fileCounts[i];
  }
  const displayParents = new Map();
  for (const [parentId, siblingIds] of [...children.entries()]) {
    if (parentId < 0 || nodes[parentId]?.[1] !== 0) continue;
    const directFiles = siblingIds.filter(id => nodes[id][1] === 1);
    if (directFiles.length === 0) continue;
    const totalBytes = directFiles.reduce((total, id) => total + nodes[id][3], 0);
    const groupId = nodes.length;
    nodes.push([
      parentId, 5,
      '[' + directFiles.length.toLocaleString('es-ES') + (directFiles.length === 1 ? ' Archivo]' : ' Archivos]'),
      totalBytes, 0
    ]);
    children.set(parentId, siblingIds.filter(id => nodes[id][1] !== 1).concat(groupId));
    children.set(groupId, directFiles);
    for (const fileId of directFiles) displayParents.set(fileId, groupId);
    let allocated = 0, missing = 0;
    for (const fileId of directFiles) {
      allocated += allocatedTotals[fileId];
      missing += missingAllocated[fileId];
    }
    nodes[groupId][5] = missing ? null : allocated;
    // Los grupos pequeños se muestran abiertos como en TreeSize. Los grandes,
    // plegados: no creamos miles de filas al abrir el HTML.
    if (directFiles.length <= 20) expanded.add(groupId);
  }

  function parentOf(id) {
    return displayParents.has(id) ? displayParents.get(id) : nodes[id][0];
  }

  const roots = children.get(-1) || [];
  roots.forEach(id => expanded.add(id));

  document.getElementById('root').textContent = metadata.rootPath;
  document.getElementById('computer').textContent = 'Equipo: ' + metadata.computer;
  document.getElementById('entries').textContent = Number(metadata.entries).toLocaleString('es-ES');
  document.getElementById('files').textContent = Number(metadata.files).toLocaleString('es-ES');
  document.getElementById('directories').textContent = Number(metadata.directories).toLocaleString('es-ES');
  document.getElementById('errors').textContent =
    (Number(metadata.errors) > 0 ? '✗ ' : '✓ ') + Number(metadata.errors).toLocaleString('es-ES');
  document.getElementById('errors').classList.add(Number(metadata.errors) > 0 ? 'state-problem' : 'state-ok');

  // Los bytes del índice son tamaño lógico. GB usa 1000; GiB usa 1024.
  // Nunca llamar GB a un valor calculado dividiendo entre 1024.
  function formatNumber(value, maximumFractionDigits = 2) {
    return value.toLocaleString('es-ES', { maximumFractionDigits });
  }
  function formatBytes(bytes, mode = sizeUnit) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (mode === 'bytes') return formatNumber(bytes, 0) + ' B';
    if (mode === 'GB') return formatNumber(bytes / 1e9) + ' GB';
    if (mode === 'GiB') return formatNumber(bytes / (1024 ** 3)) + ' GiB';
    const binary = mode !== 'decimal';
    const base = binary ? 1024 : 1000;
    const units = binary ? ['B','KiB','MiB','GiB','TiB','PiB'] : ['B','KB','MB','GB','TB','PB'];
    let value = bytes;
    let unit = 0;
    while (value >= base && unit < units.length - 1) { value /= base; unit++; }
    return formatNumber(value, unit >= 2 ? 2 : 0) + ' ' + units[unit];
  }
  const logicalBytes = metadata.sizeBytes;
  document.getElementById('decimalTotal').textContent = formatBytes(logicalBytes, 'GB');
  document.getElementById('binaryTotal').textContent = formatBytes(logicalBytes, 'GiB');
  document.getElementById('exactTotal').textContent = formatBytes(logicalBytes, 'bytes');
  function refreshTotalSize() {
    document.getElementById('totalSize').textContent = formatBytes(logicalBytes);
  }
  refreshTotalSize();
  if (allocation) {
    document.getElementById('allocatedTotal').textContent =
      formatBytes(allocation.allocatedBytesMeasured) +
      (allocation.complete ? '' : ' (parcial)');
    document.getElementById('allocationStatus').textContent =
      allocation.measuredFiles.toLocaleString('es-ES') + ' / ' +
      allocation.totalFiles.toLocaleString('es-ES') + ' archivos · ' +
      allocation.failedFiles + ' fallos';
    document.getElementById('allocationStatus').classList.add(allocation.complete ? 'state-ok' : 'state-review');
    document.getElementById('allocationStatus').textContent =
      (allocation.complete ? '✓ ' : '! ') + document.getElementById('allocationStatus').textContent;
  }

  const slash = metadata.rootPath.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/';
  function pathOf(id) {
    const parts = [];
    while (id >= 0 && parentOf(id) >= 0) {
      // El grupo no existe en disco: nunca se intercala en las rutas locales.
      if (nodes[id][1] !== 5) parts.push(nodes[id][2]);
      id = parentOf(id);
    }
    return metadata.rootPath + (parts.length && !metadata.rootPath.endsWith(slash) ? slash : '') + parts.reverse().join(slash);
  }
  function fileUrl(path) {
    const normalized = path.split(String.fromCharCode(92)).join('/');
    const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
    if (normalized.startsWith('//')) return 'file:' + encoded;
    if (normalized.startsWith('/')) return 'file://' + encoded;
    return 'file:///' + encoded;
  }

  function childrenSorted(parentId) {
    let list = sorted.get(parentId);
    if (list) return list;
    const original = children.get(parentId) || [];
    list = original.slice().sort((a, b) =>
      nodes[b][3] - nodes[a][3] || String(nodes[a][2]).localeCompare(String(nodes[b][2])));
    sorted.set(parentId, list);
    return list;
  }

  function computeMatches() {
    const query = search.value.trim().toLowerCase();
    const kind = filter.value;
    const activityKind = activityFilter.value;
    filtering = Boolean(query) || kind !== 'all' || activityKind !== 'all';
    if (!filtering) { mask = null; return; }

    mask = new Uint8Array(nodes.length);
    const pathQuery = query.includes('/') || query.includes(String.fromCharCode(92));
    for (let i = 0; i < nodes.length; i++) {
      if (kind !== 'all' && names[nodes[i][1]] !== kind) continue;
      if (activityKind !== 'all') {
        const candidate = activityByPath.get(activityKey(pathOf(i)));
        if (!candidate || (activityKind === 'review' && candidate.suggestion !== 'REVISAR')) continue;
      }
      if (query && !String(nodes[i][2]).toLowerCase().includes(query)
          && (!pathQuery || !pathOf(i).toLowerCase().includes(query))) continue;

      let parent = i;
      while (parent >= 0 && mask[parent] === 0) {
        mask[parent] = 1;
        parent = parentOf(parent);
      }
    }
  }

  function formatFileDate(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? new Date(value).toLocaleString('es-ES', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
      : '—';
  }

  function makeRow(id, depth) {
    const node = nodes[id];
    const type = node[1];
    const hasChildren = (type === 0 || type === 5) && (children.get(id) || []).length > 0;
    const open = hasChildren && !collapsed.has(id) && (expanded.has(id) || filtering);

    const row = document.createElement('div');
    row.className = 'row' + (type === 4 ? ' error' : '');
    if (type === 4) row.setAttribute('aria-label', 'Error de lectura del inventario');
    const allocatedValue = type === 0 ? (missingAllocated[id] ? null : allocatedTotals[id])
      : type === 5 ? node[5]
      : type === 1 ? node[5] : null;
    row.title = (type === 5 ? 'Grupo virtual de archivos · ' : '') + pathOf(id) +
      '\nTamaño lógico: ' + formatBytes(node[3], 'bytes') +
      ' · ' + formatBytes(node[3], 'GB') + ' · ' + formatBytes(node[3], 'GiB') +
      '\nOcupado en archivos: ' + (allocation && allocatedValue !== null ?
        formatBytes(allocatedValue, 'bytes') : 'No disponible');
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.left = Math.min(depth, 40) * 18 + 'px';
    bar.style.width = Math.max(.3, Math.min(100, node[3] / Math.max(1, metadata.sizeBytes) * 100)) + '%';

    const content = document.createElement('div');
    content.className = 'content';
    const treeCell = document.createElement('div');
    treeCell.className = 'treecell';
    treeCell.style.paddingLeft = Math.min(depth, 40) * 18 + 'px';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'toggle' + (hasChildren ? '' : ' empty');
    toggle.textContent = open ? '⌄' : '›';
    toggle.setAttribute('aria-label', open ? 'Colapsar carpeta' : 'Expandir carpeta');
    if (hasChildren) toggle.addEventListener('click', event => {
      event.stopPropagation();
      if (open) { collapsed.add(id); expanded.delete(id); }
      else { collapsed.delete(id); expanded.add(id); }
      render();
    });

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = icons[type];
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = type === 4 ? '—' : formatBytes(node[3]);
    if (indentSizes) {
      size.classList.add('size-indented');
      size.style.setProperty('--size-offset', Math.min(depth, 10) * 14 + 'px');
    }

    let name;
    if (type === 0) {
      name = document.createElement('a');
      name.className = 'name-link';
      name.href = fileUrl(pathOf(id));
      name.title = 'Abrir carpeta local: ' + pathOf(id);
      name.textContent = node[2];
      name.addEventListener('click', event => event.stopPropagation());
    } else {
      name = document.createElement('span');
      name.className = 'name';
      name.textContent = node[2];
    }

    const allocatedCell = document.createElement('span');
    allocatedCell.className = 'allocated';
    allocatedCell.textContent = allocation && allocatedValue !== null
      ? formatBytes(allocatedValue) : '—';
    if (!allocation || allocatedValue === null) allocatedCell.classList.add('unknown');
    allocatedCell.title = allocation && allocatedValue !== null
      ? formatBytes(allocatedValue, 'bytes') + ' asignados (archivos)'
      : 'No medido o hay archivos sin medición';

    const modifiedCell = document.createElement('span');
    modifiedCell.className = 'modified';
    const modifiedAt = type === 5 ? null :
      type === 0 ? latestChange[id] : node[4];
    modifiedCell.textContent = formatFileDate(modifiedAt);
    modifiedCell.title = type === 0
      ? 'Última modificación conocida entre esta carpeta y sus descendientes. No es último uso.'
      : type === 5 ? 'Nodo virtual: sin fecha propia'
      : 'Fecha de modificación del archivo (mtime)';

    const createdCell = document.createElement('span');
    createdCell.className = 'created';
    createdCell.textContent = type === 5 ? '—' : formatFileDate(node[6]);
    createdCell.title = type === 5
      ? 'Nodo virtual sin fechas'
      : 'Creación de la entrada en el sistema de archivos (birthtime). Puede variar al copiar.';

    const accessedCell = document.createElement('span');
    accessedCell.className = 'accessed';
    accessedCell.textContent = type === 5 ? '—' : formatFileDate(node[7]);
    accessedCell.title = type === 5
      ? 'Nodo virtual sin fechas'
      : 'Último acceso registrado (atime), no necesariamente uso humano. Puede no actualizarse.';

    const fileCount = document.createElement('span');
    fileCount.className = 'file-count';
    if (type === 0) {
      const total = fileCounts[id] || 0;
      fileCount.textContent = '(' + total.toLocaleString('es-ES') + (total === 1 ? ' archivo)' : ' archivos)');
      fileCount.title = 'Archivos contenidos en esta carpeta y sus subcarpetas';
      if (total === 0) fileCount.classList.add('zero');
    } else if (type === 5) {
      fileCount.textContent = '';
    }

    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = type === 0 ? 'carpeta' : type === 1 ? 'archivo' : type === 5 ? 'grupo virtual' : names[type];
    // La jerarquía y el número de archivos quedan juntos; el tamaño se
    // alinea a la derecha, como en la referencia del usuario.
    treeCell.append(toggle, icon, name);
    if (type === 0) {
      treeCell.append(fileCount);
      const artifact = activityByPath.get(activityKey(pathOf(id)));
      if (artifact) {
        const marker = document.createElement('span');
        marker.className = 'artifact-label' + (artifact.suggestion === 'REVISAR' ? ' review' : '');
        marker.textContent = artifact.suggestion === 'REVISAR' ? '! REVISAR' : 'ℹ OBSERVAR';
        marker.title = artifact.family + ' · ' + artifact.activity + ' · ' +
          artifact.evidence + ' · ' + artifact.reason +
          ' · Confianza en el patrón: ' + artifact.confidence;
        treeCell.append(marker);
      }
    }
    content.append(treeCell, size, allocatedCell, modifiedCell, createdCell, accessedCell, kind);
    row.append(bar, content);
    if (hasChildren) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', event => {
        if (event.target === toggle || event.target === name) return;
        if (open) { collapsed.add(id); expanded.delete(id); }
        else { collapsed.delete(id); expanded.add(id); }
        render();
      });
    }
    return row;
  }

  function render() {
    const oldScroll = rowsHost.scrollTop;
    const fragment = document.createDocumentFragment();
    const stack = childrenSorted(-1).slice().reverse().map(id => [id, 0]);
    let count = 0;
    let truncated = false;

    while (stack.length) {
      const pair = stack.pop();
      const id = pair[0], depth = pair[1];
      if (mask && !mask[id]) continue;
      if (count >= limit) { truncated = true; break; }
      fragment.appendChild(makeRow(id, depth));
      count++;
      if ((nodes[id][1] === 0 || nodes[id][1] === 5) && !collapsed.has(id) && (expanded.has(id) || filtering)) {
        const childIds = childrenSorted(id);
        for (let i = childIds.length - 1; i >= 0; i--) {
          if (!mask || mask[childIds[i]]) stack.push([childIds[i], depth + 1]);
        }
      }
    }

    rowsHost.replaceChildren(fragment);
    rowsHost.scrollTop = oldScroll;
    more.hidden = !truncated;
    status.textContent = (count === 0 ? 'Sin resultados · ' : 'Mostrando ' + count.toLocaleString('es-ES') + ' filas · ')
      + metadata.entries.toLocaleString('es-ES') + ' entradas indexadas'
      + (truncated ? ' · Despliega o pulsa «Mostrar más»' : '');
  }

  let searchTimer;
  function onFilterChanged() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      limit = PAGE_SIZE;
      status.textContent = 'Buscando…';
      computeMatches();
      render();
    }, 250);
  }
  search.addEventListener('input', onFilterChanged);
  filter.addEventListener('change', onFilterChanged);
  activityFilter.addEventListener('change', onFilterChanged);

  more.onclick = () => { limit += PAGE_SIZE; render(); };
  sizeIndent.onclick = () => {
    indentSizes = !indentSizes;
    sizeIndent.setAttribute('aria-pressed', String(indentSizes));
    sizeIndent.textContent = 'Indentar tamaños: ' + (indentSizes ? 'Sí' : 'No');
    render();
  };
  unitMode.addEventListener('change', () => {
    sizeUnit = unitMode.value;
    refreshTotalSize();
    render();
  });
  collapse.onclick = () => {
    expanded.clear();
    collapsed.clear();
    for (const id of roots) collapsed.add(id);
    limit = PAGE_SIZE;
    render();
  };
  expand3.onclick = () => {
    expanded.clear();
    collapsed.clear();
    for (let i = 0; i < nodes.length; i++) {
      if ((nodes[i][1] === 0 || nodes[i][1] === 5) && depthOf(i) < 3) expanded.add(i);
    }
    limit = PAGE_SIZE;
    render();
  };
  function depthOf(id) {
    let depth = 0;
    while (parentOf(id) >= 0) { depth++; id = parentOf(id); }
    return depth;
  }

  // Solo se crean como máximo 400 filas al abrir. Más filas se solicitan
  // explícitamente. El árbol completo sigue disponible en el índice.
  try { render(); }
  catch (error) {
    rowsHost.textContent = 'Error al renderizar el árbol: ' + String(error);
    status.textContent = 'Error en el visor';
  }
})();
</script>
</body>
</html>`);
    output.end();
    await finished(output);
    await rename(tempPath, outputPath);
    return outputPath;
  } catch (error) {
    output.destroy();
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readIndex(
  indexPath: string,
  visitor: (record: TreeIndexRecord) => void | Promise<void>,
): Promise<void> {
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    await visitor(JSON.parse(line) as TreeIndexRecord);
  }
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
