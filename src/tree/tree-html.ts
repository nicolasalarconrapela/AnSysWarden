import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { basename, resolve } from 'node:path';
import type { TreeEntryRecord, TreeIndexRecord, TreeScanMetadata } from './native-tree-scanner';

interface TreeHtmlOptions {
  indexPath: string;
  outputPath: string;
  metadata: TreeScanMetadata;
}

export async function writeNativeTreeHtml(options: TreeHtmlOptions): Promise<string> {
  const indexPath = resolve(options.indexPath);
  const outputPath = resolve(options.outputPath);
  const summaries = new Map<string, number>();

  await readIndex(indexPath, (record) => {
    if (record.record === 'directory-summary') summaries.set(record.path, record.sizeBytes);
  });

  const output = createWriteStream(outputPath, { encoding: 'utf8', flags: 'w' });
  const write = async (text: string): Promise<void> => {
    if (!output.write(text)) await once(output, 'drain');
  };

  const metadataJson = safeJson(options.metadata);
  await write(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AnSysWarden · Tree</title>
<style>
:root{color-scheme:dark;--bg:#171717;--panel:#151515;--line:#303030;--text:#f3f3f3;--muted:#aaa;--bar:#555;--bar0:#686868;--link:#8ec5ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:14px 18px}.title{font-size:19px;font-weight:700}.meta,.summary{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted)}.meta{margin-top:4px}.summary{padding:9px 18px;background:#1b1b1b;border-bottom:1px solid var(--line)}.summary strong{color:var(--text)}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.toolbar input,.toolbar select,.toolbar button{background:#222;color:var(--text);border:1px solid #3b3b3b;border-radius:5px;padding:7px 9px}.toolbar input{min-width:280px;flex:1}.toolbar button{cursor:pointer}.tree{width:100%;overflow:auto}.row{position:relative;display:flex;align-items:center;min-height:28px;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden}.row.hidden{display:none}.row:hover{background:#262626}.bar{position:absolute;top:1px;bottom:1px;background:var(--bar);opacity:.82;pointer-events:none}.row.depth0 .bar{background:var(--bar0)}.content{position:relative;z-index:2;display:flex;align-items:center;width:100%;min-width:760px;padding:3px 12px}.toggle{width:18px;border:0;background:transparent;color:#ddd;cursor:pointer;padding:0;font-size:15px;line-height:1}.toggle.empty{visibility:hidden}.icon{width:20px;text-align:center;margin-right:4px}.size{width:92px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;margin-right:10px}.name{overflow:hidden;text-overflow:ellipsis}.name-link{color:var(--link);text-decoration:none;overflow:hidden;text-overflow:ellipsis}.name-link:hover{text-decoration:underline;text-underline-offset:2px}.type{margin-left:auto;color:var(--muted);font-size:11px}.error{color:#ff8585}.empty-state{padding:30px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<header>
  <div class="title">AnSysWarden · Tree</div>
  <div class="meta"><span id="root"></span><span id="computer"></span><span>Scanner: native</span></div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Buscar archivo, carpeta o ruta…" autocomplete="off">
    <select id="typeFilter"><option value="all">Todo</option><option value="directory">Carpetas</option><option value="file">Archivos</option><option value="symlink">Enlaces</option></select>
    <button id="expand3" type="button">Expandir 3 niveles</button>
    <button id="collapse" type="button">Colapsar todo</button>
  </div>
</header>
<div class="summary">
  <span>Entradas: <strong id="entries"></strong></span>
  <span>Archivos: <strong id="files"></strong></span>
  <span>Carpetas: <strong id="directories"></strong></span>
  <span>Tamaño: <strong id="totalSize"></strong></span>
  <span>Errores: <strong id="errors"></strong></span>
</div>
<main><div class="tree" id="rows">
<script id="metadata" type="application/json">${metadataJson}</script>
`);

  const rootSize = Math.max(1, options.metadata.sizeBytes);
  await readIndex(indexPath, async (record) => {
    if (record.record !== 'entry') return;
    const entry = record as TreeEntryRecord;
    const size = entry.type === 'directory' ? summaries.get(entry.path) ?? 0 : entry.sizeBytes;
    const hasChildren = entry.type === 'directory';
    const path = escapeHtml(entry.path);
    const parent = escapeHtml(entry.parentPath ?? '');
    const name = escapeHtml(entry.name || basename(entry.path));
    const fileUrl = escapeHtmlAttribute(toFileUrl(entry.path));
    const icon = entry.type === 'directory' ? '📁' : entry.type === 'file' ? '📄' : entry.type === 'symlink' ? '↗' : '•';
    const width = Math.max(0.3, Math.min(100, (size / rootSize) * 100));
    const nameHtml = entry.type === 'directory'
      ? `<a class="name-link" href="${fileUrl}" title="Abrir carpeta: ${path}" onclick="event.stopPropagation()">${name}</a>`
      : `<span class="name">${name}</span>`;

    await write(`<div class="row depth${entry.depth}" data-path="${escapeHtmlAttribute(entry.path)}" data-parent="${escapeHtmlAttribute(entry.parentPath ?? '')}" data-depth="${entry.depth}" data-type="${entry.type}" data-collapsed="false">
  <div class="bar" style="left:${entry.depth * 18}px;width:${width}%"></div>
  <div class="content" style="padding-left:${8 + entry.depth * 18}px">
    <button class="toggle${hasChildren ? '' : ' empty'}" type="button">${hasChildren ? '⌄' : '›'}</button>
    <span class="icon">${icon}</span>
    <span class="size">${formatBytes(size)}</span>
    ${nameHtml}
    <span class="type">${entry.type === 'directory' ? 'carpeta' : entry.type === 'file' ? 'archivo' : entry.type}</span>
  </div>
</div>\n`);
  });

  await readIndex(indexPath, async (record) => {
    if (record.record !== 'error') return;
    await write(`<div class="row error" data-path="${escapeHtmlAttribute(record.path)}" data-parent="${escapeHtmlAttribute(record.parentPath ?? '')}" data-depth="${record.depth}" data-type="error"><div class="content" style="padding-left:${8 + record.depth * 18}px"><span class="toggle empty">›</span><span class="icon">⚠</span><span class="size">—</span><span class="name">${escapeHtml(record.name)}</span><span class="type">${escapeHtml(record.code ?? 'error')}</span></div></div>\n`);
  });

  await write(`</div></main>
<script>
(() => {
  const metadata = JSON.parse(document.getElementById('metadata').textContent);
  const rows = [...document.querySelectorAll('.row')];
  const byPath = new Map(rows.map(row => [row.dataset.path, row]));
  const children = new Map();
  for (const row of rows) {
    const parent = row.dataset.parent || '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }

  document.getElementById('root').textContent = metadata.rootPath;
  document.getElementById('computer').textContent = 'Equipo: ' + metadata.computer;
  document.getElementById('entries').textContent = Number(metadata.entries).toLocaleString('es-ES');
  document.getElementById('files').textContent = Number(metadata.files).toLocaleString('es-ES');
  document.getElementById('directories').textContent = Number(metadata.directories).toLocaleString('es-ES');
  document.getElementById('errors').textContent = Number(metadata.errors).toLocaleString('es-ES');
  document.getElementById('totalSize').textContent = ${JSON.stringify(formatBytes(options.metadata.sizeBytes))};

  function descendants(path) {
    const result = [];
    const stack = [...(children.get(path) || [])];
    while (stack.length) {
      const row = stack.pop();
      result.push(row);
      stack.push(...(children.get(row.dataset.path) || []));
    }
    return result;
  }

  function isHiddenByCollapsedAncestor(row) {
    let parent = row.dataset.parent;
    while (parent) {
      const ancestor = byPath.get(parent);
      if (ancestor && ancestor.dataset.collapsed === 'true') return true;
      parent = ancestor?.dataset.parent || '';
    }
    return false;
  }

  function refresh() {
    const query = document.getElementById('search').value.trim().toLowerCase();
    const type = document.getElementById('typeFilter').value;
    const filtering = Boolean(query) || type !== 'all';

    for (const row of rows) {
      const typeMatch = type === 'all' || row.dataset.type === type;
      const textMatch = !query || (row.dataset.path || '').toLowerCase().includes(query);
      let visible = typeMatch && textMatch;

      if (!filtering && isHiddenByCollapsedAncestor(row)) visible = false;
      if (filtering && !visible) {
        const path = row.dataset.path || '';
        visible = descendants(path).some(child => {
          const childType = type === 'all' || child.dataset.type === type;
          const childText = !query || (child.dataset.path || '').toLowerCase().includes(query);
          return childType && childText;
        });
      }

      row.classList.toggle('hidden', !visible);
      const toggle = row.querySelector('.toggle');
      if (toggle && !toggle.classList.contains('empty')) toggle.textContent = row.dataset.collapsed === 'true' ? '›' : '⌄';
    }
  }

  for (const row of rows) {
    const toggle = row.querySelector('.toggle');
    if (!toggle || toggle.classList.contains('empty')) continue;
    const toggleRow = (event) => {
      event?.stopPropagation();
      row.dataset.collapsed = row.dataset.collapsed === 'true' ? 'false' : 'true';
      refresh();
    };
    toggle.addEventListener('click', toggleRow);
    row.addEventListener('dblclick', toggleRow);
  }

  document.getElementById('collapse').onclick = () => {
    for (const row of rows) if (row.dataset.type === 'directory') row.dataset.collapsed = 'true';
    refresh();
  };

  document.getElementById('expand3').onclick = () => {
    for (const row of rows) {
      if (row.dataset.type !== 'directory') continue;
      row.dataset.collapsed = Number(row.dataset.depth) >= 3 ? 'true' : 'false';
    }
    refresh();
  };

  document.getElementById('search').addEventListener('input', refresh);
  document.getElementById('typeFilter').addEventListener('change', refresh);
  refresh();
})();
</script>
</body>
</html>`);

  output.end();
  await once(output, 'finish');
  return outputPath;
}

async function readIndex(indexPath: string, visitor: (record: TreeIndexRecord) => void | Promise<void>): Promise<void> {
  const input = createReadStream(indexPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    await visitor(JSON.parse(line) as TreeIndexRecord);
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function toFileUrl(path: string): string {
  const normalized = path.split(String.fromCharCode(92)).join('/');
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  if (normalized.startsWith('//')) return `file:${encodeURI(normalized)}`;
  if (normalized.startsWith('/')) return `file://${encodeURI(normalized)}`;
  return `file:///${encodeURI(normalized)}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}
