import type { ScanDocument } from '../backend/types';
import {
  buildReclaimReport,
  type ReclaimReport,
  type ReclaimTreeDecision,
  type ReclaimTreeNode,
} from '../reclaim/reclaim-engine';

interface ViewerNode {
  name: string;
  path: string;
  sizeBytes: number;
  decision: ReclaimTreeDecision;
  children: ViewerNode[];
}

interface ViewerPayload {
  scanId: string;
  createdAt: string;
  rootPath: string;
  scanner: string;
  computer: string;
  totalEntries: number;
  confirmedRecoverableBytes: number;
  tree: ViewerNode[];
}

export function buildPcTreeHtml(scan: ScanDocument, report?: ReclaimReport): string {
  const effectiveReport = report ?? buildReclaimReport(scan);
  const payload: ViewerPayload = {
    scanId: scan.id,
    createdAt: scan.createdAt,
    rootPath: scan.origin?.rootPath ?? scan.entries[0]?.path ?? '-',
    scanner: scan.origin?.scanner ?? scan.source,
    computer: scan.origin?.hostname ?? scan.computer,
    totalEntries: scan.entries.length,
    confirmedRecoverableBytes: effectiveReport.confirmedRecoverableBytes,
    tree: effectiveReport.tree.map(toViewerNode),
  };

  const json = serializeForScript(payload);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AnSysWarden · Vista de disco</title>
<style>
:root{color-scheme:dark;--bg:#171717;--panel:#202020;--panel2:#2a2a2a;--line:#353535;--text:#f3f3f3;--muted:#a8a8a8;--bar:#565656;--bar-strong:#686868;--keep:#59d47f;--review:#f0bf4c;--delete:#f06a67;--protect:#68c7d9;--ask:#b78fff;--optimize:#76aefc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{position:sticky;top:0;z-index:5;background:#151515;border-bottom:1px solid var(--line);padding:14px 18px}.title{font-size:19px;font-weight:700}.meta{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);margin-top:4px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.toolbar input,.toolbar select,.toolbar button{background:#222;color:var(--text);border:1px solid #3b3b3b;border-radius:5px;padding:7px 9px}.toolbar input{min-width:260px;flex:1}.toolbar button{cursor:pointer}.toolbar button:hover{border-color:#777}.summary{display:flex;gap:10px;flex-wrap:wrap;padding:10px 18px;background:#1b1b1b;border-bottom:1px solid var(--line);color:var(--muted)}.summary strong{color:var(--text)}main{padding:0}.tree{width:100%;overflow:auto}.row{position:relative;display:flex;align-items:center;min-height:28px;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden}.row:hover{background:#262626}.bar{position:absolute;left:0;top:1px;bottom:1px;background:var(--bar);opacity:.82;pointer-events:none}.row.depth0 .bar{background:var(--bar-strong)}.content{position:relative;z-index:2;display:flex;align-items:center;width:100%;min-width:720px;padding:3px 12px}.treecell{display:flex;align-items:center;min-width:0;flex:1}.toggle{width:18px;border:0;background:transparent;color:#d8d8d8;cursor:pointer;padding:0;font-size:12px}.toggle.empty{visibility:hidden}.folder{width:20px;text-align:center;margin-right:4px}.size{width:92px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;margin-right:10px}.name{overflow:hidden;text-overflow:ellipsis}.decision{margin-left:auto;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:700;background:#242424;border:1px solid #444}.decision.KEEP{color:var(--keep)}.decision.REVIEW{color:var(--review)}.decision.DELETE{color:var(--delete)}.decision.PROTECT{color:var(--protect)}.decision.ASK{color:var(--ask)}.decision.OPTIMIZE{color:var(--optimize)}.decision.ROOT{color:var(--muted)}body.labels-collapsed .decision{display:none}.empty-state{padding:30px;text-align:center;color:var(--muted)}
</style>
</head>
<body>
<header>
  <div class="title">AnSysWarden · Vista de disco</div>
  <div class="meta"><span id="root"></span><span id="scanner"></span><span id="computer"></span></div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Buscar carpeta o ruta…" autocomplete="off">
    <select id="decisionFilter">
      <option value="ALL">Todos los estados</option>
      <option value="KEEP">CONSERVAR</option>
      <option value="REVIEW">REVISAR</option>
      <option value="DELETE">ELIMINAR</option>
      <option value="PROTECT">PROTEGER</option>
      <option value="ASK">PREGUNTAR</option>
      <option value="OPTIMIZE">OPTIMIZAR</option>
    </select>
    <button id="toggleLabels">Ocultar estados</button>
    <button id="expand">Expandir 3 niveles</button>
    <button id="collapse">Colapsar</button>
  </div>
</header>
<div class="summary">
  <span>Entradas: <strong id="entries"></strong></span>
  <span>Tamaño raíz: <strong id="totalSize"></strong></span>
  <span>Recuperable confirmado: <strong id="recoverable"></strong></span>
  <span>Escaneo: <strong id="created"></strong></span>
</div>
<main><div class="tree" id="rows"></div></main>
<script id="payload" type="application/json">${json}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('payload').textContent);
  const rows = document.getElementById('rows');
  const search = document.getElementById('search');
  const decisionFilter = document.getElementById('decisionFilter');
  const toggleLabels = document.getElementById('toggleLabels');
  const expanded = new Set();
  const roots = data.tree || [];
  const rootTotal = Math.max(1, ...roots.map(node => node.sizeBytes || 0));
  const labels = {KEEP:'CONSERVAR',REVIEW:'REVISAR',DELETE:'ELIMINAR',PROTECT:'PROTEGER',ASK:'PREGUNTAR',OPTIMIZE:'OPTIMIZAR',ROOT:'RAÍZ'};
  let labelsCollapsed = false;

  document.getElementById('root').textContent = data.rootPath;
  document.getElementById('scanner').textContent = 'Scanner: ' + data.scanner;
  document.getElementById('computer').textContent = 'Equipo: ' + data.computer;
  document.getElementById('entries').textContent = Number(data.totalEntries).toLocaleString('es-ES');
  document.getElementById('totalSize').textContent = formatBytes(rootTotal);
  document.getElementById('recoverable').textContent = formatBytes(data.confirmedRecoverableBytes || 0);
  document.getElementById('created').textContent = new Date(data.createdAt).toLocaleString('es-ES');

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const decimals = unit >= 3 ? 1 : unit >= 2 ? 1 : 0;
    return value.toFixed(decimals) + ' ' + units[unit];
  }

  function nodeKey(node) { return node.path; }

  function matches(node, query, decision) {
    const textMatch = !query || node.path.toLowerCase().includes(query);
    const decisionMatch = decision === 'ALL' || node.decision === decision;
    return textMatch && decisionMatch;
  }

  function hasMatchingDescendant(node, query, decision) {
    return (node.children || []).some(child => matches(child, query, decision) || hasMatchingDescendant(child, query, decision));
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const decision = decisionFilter.value;
    rows.textContent = '';
    let visibleCount = 0;

    function append(node, depth) {
      const direct = matches(node, query, decision);
      const descendant = hasMatchingDescendant(node, query, decision);
      if (!direct && !descendant) return;

      visibleCount++;
      const open = expanded.has(nodeKey(node)) || Boolean(query);
      const row = document.createElement('div');
      row.className = 'row depth' + depth;
      row.title = node.path;

      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.left = (depth * 18) + 'px';
      bar.style.width = Math.max(0.3, Math.min(100, (node.sizeBytes / rootTotal) * 100)) + '%';

      const content = document.createElement('div');
      content.className = 'content';
      content.style.paddingLeft = (8 + depth * 18) + 'px';

      const treeCell = document.createElement('div');
      treeCell.className = 'treecell';

      const toggle = document.createElement('button');
      toggle.className = 'toggle' + ((node.children || []).length ? '' : ' empty');
      toggle.textContent = open ? '⌄' : '›';
      toggle.onclick = event => {
        event.stopPropagation();
        const key = nodeKey(node);
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        render();
      };

      const folder = document.createElement('span');
      folder.className = 'folder';
      folder.textContent = (node.children || []).length ? '📁' : '📄';

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(node.sizeBytes);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = node.name;

      treeCell.append(toggle, folder, size, name);

      const decisionCell = document.createElement('span');
      decisionCell.className = 'decision ' + node.decision;
      decisionCell.textContent = labels[node.decision] || node.decision;

      content.append(treeCell, decisionCell);
      row.append(bar, content);
      rows.append(row);

      if (open || descendant) {
        const children = [...(node.children || [])].sort((a,b) => b.sizeBytes - a.sizeBytes);
        for (const child of children) append(child, depth + 1);
      }
    }

    [...roots].sort((a,b) => b.sizeBytes - a.sizeBytes).forEach(node => append(node, 0));

    if (!visibleCount) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No hay resultados para este filtro.';
      rows.append(empty);
    }
  }

  function expandToDepth(nodes, depth, maxDepth) {
    for (const node of nodes) {
      if (depth < maxDepth && (node.children || []).length) expanded.add(nodeKey(node));
      expandToDepth(node.children || [], depth + 1, maxDepth);
    }
  }

  toggleLabels.onclick = () => {
    labelsCollapsed = !labelsCollapsed;
    document.body.classList.toggle('labels-collapsed', labelsCollapsed);
    toggleLabels.textContent = labelsCollapsed ? 'Mostrar estados' : 'Ocultar estados';
  };

  document.getElementById('expand').onclick = () => { expanded.clear(); expandToDepth(roots, 0, 3); render(); };
  document.getElementById('collapse').onclick = () => { expanded.clear(); render(); };
  search.addEventListener('input', render);
  decisionFilter.addEventListener('change', render);

  expandToDepth(roots, 0, 4);
  render();
})();
</script>
</body>
</html>`;
}

function toViewerNode(node: ReclaimTreeNode): ViewerNode {
  return {
    name: node.name,
    path: node.path,
    sizeBytes: node.sizeBytes,
    decision: node.decision,
    children: node.children.map(toViewerNode),
  };
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
