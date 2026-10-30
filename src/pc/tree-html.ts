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
<title>AnSysWarden · Tree</title>
<style>
:root{color-scheme:dark;--bg:#101317;--panel:#171b21;--panel2:#1d222a;--line:#2a313b;--text:#eef2f6;--muted:#9aa6b2;--accent:#68a7ff;--keep:#4fd17a;--review:#f0bf4c;--delete:#ef6461;--protect:#61c3d9;--ask:#b58cff;--optimize:#6ea8fe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{position:sticky;top:0;z-index:4;background:rgba(16,19,23,.96);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:18px 22px}.title{font-size:20px;font-weight:700}.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);margin-top:6px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.toolbar input,.toolbar select,.toolbar button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 10px}.toolbar input{min-width:280px;flex:1}.toolbar button{cursor:pointer}.toolbar button:hover{border-color:var(--accent)}main{padding:18px 22px}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.card .label{color:var(--muted);font-size:12px}.card .value{font-size:20px;font-weight:700;margin-top:2px}.table{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}.row{display:grid;grid-template-columns:minmax(330px,1fr) 110px 90px 135px;min-height:34px;align-items:center;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.row.head{position:sticky;top:133px;z-index:3;background:var(--panel2);font-weight:700;color:var(--muted)}.cell{padding:7px 10px;min-width:0}.name{display:flex;align-items:center;gap:6px}.toggle{border:0;background:transparent;color:var(--muted);cursor:pointer;width:20px;padding:0;font-size:13px}.toggle.empty{visibility:hidden}.node-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.size,.percent{text-align:right;font-variant-numeric:tabular-nums}.bar-wrap{height:7px;background:#0d0f12;border-radius:4px;overflow:hidden;margin-top:3px}.bar{height:100%;background:var(--accent);min-width:1px}.decision{font-size:12px;font-weight:700}.decision.KEEP{color:var(--keep)}.decision.REVIEW{color:var(--review)}.decision.DELETE{color:var(--delete)}.decision.PROTECT{color:var(--protect)}.decision.ASK{color:var(--ask)}.decision.OPTIMIZE{color:var(--optimize)}.decision.ROOT{color:var(--muted)}.hidden{display:none}.empty-state{padding:34px;text-align:center;color:var(--muted)}@media(max-width:760px){.row{grid-template-columns:minmax(220px,1fr) 95px 110px}.percent-col{display:none}.row.head{top:169px}.toolbar input{min-width:180px}}
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
    <button id="expand">Expandir 2 niveles</button>
    <button id="collapse">Colapsar</button>
  </div>
</header>
<main>
  <section class="summary">
    <div class="card"><div class="label">Entradas</div><div class="value" id="entries"></div></div>
    <div class="card"><div class="label">Tamaño raíz</div><div class="value" id="totalSize"></div></div>
    <div class="card"><div class="label">Recuperable confirmado</div><div class="value" id="recoverable"></div></div>
    <div class="card"><div class="label">Escaneo</div><div class="value" id="created"></div></div>
  </section>

  <section class="table">
    <div class="row head">
      <div class="cell">Nombre</div>
      <div class="cell size">Tamaño</div>
      <div class="cell percent percent-col">%</div>
      <div class="cell">Estado</div>
    </div>
    <div id="rows"></div>
  </section>
</main>
<script id="payload" type="application/json">${json}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('payload').textContent);
  const rows = document.getElementById('rows');
  const search = document.getElementById('search');
  const decisionFilter = document.getElementById('decisionFilter');
  const expanded = new Set();
  const roots = data.tree || [];
  const totalBytes = roots.reduce((sum, node) => sum + (node.sizeBytes || 0), 0) || 1;

  const labels = {KEEP:'CONSERVAR',REVIEW:'REVISAR',DELETE:'ELIMINAR',PROTECT:'PROTEGER',ASK:'PREGUNTAR',OPTIMIZE:'OPTIMIZAR',ROOT:'RAÍZ'};
  const icons = {KEEP:'●',REVIEW:'●',DELETE:'●',PROTECT:'◆',ASK:'?',OPTIMIZE:'●',ROOT:'•'};

  document.getElementById('root').textContent = data.rootPath;
  document.getElementById('scanner').textContent = 'Scanner: ' + data.scanner;
  document.getElementById('computer').textContent = 'Equipo: ' + data.computer;
  document.getElementById('entries').textContent = Number(data.totalEntries).toLocaleString('es-ES');
  document.getElementById('totalSize').textContent = formatBytes(totalBytes);
  document.getElementById('recoverable').textContent = formatBytes(data.confirmedRecoverableBytes || 0);
  document.getElementById('created').textContent = new Date(data.createdAt).toLocaleString('es-ES');

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    const decimals = unit >= 3 ? 2 : unit >= 2 ? 1 : 0;
    return value.toFixed(decimals) + ' ' + units[unit];
  }

  function nodeKey(node) { return node.path; }

  function matches(node, query, decision) {
    const textMatch = !query || node.path.toLowerCase().includes(query);
    const decisionMatch = decision === 'ALL' || node.decision === decision;
    return textMatch && decisionMatch;
  }

  function hasMatchingDescendant(node, query, decision) {
    for (const child of node.children || []) {
      if (matches(child, query, decision) || hasMatchingDescendant(child, query, decision)) return true;
    }
    return false;
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
      const row = document.createElement('div');
      row.className = 'row';
      row.title = node.path;

      const nameCell = document.createElement('div');
      nameCell.className = 'cell name';
      nameCell.style.paddingLeft = (10 + depth * 18) + 'px';

      const toggle = document.createElement('button');
      toggle.className = 'toggle' + ((node.children || []).length ? '' : ' empty');
      const open = expanded.has(nodeKey(node)) || Boolean(query);
      toggle.textContent = open ? '▼' : '▶';
      toggle.onclick = () => {
        const key = nodeKey(node);
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        render();
      };

      const nodeName = document.createElement('span');
      nodeName.className = 'node-name';
      nodeName.textContent = node.name;
      nameCell.append(toggle, nodeName);

      const sizeCell = document.createElement('div');
      sizeCell.className = 'cell size';
      sizeCell.textContent = formatBytes(node.sizeBytes);
      const barWrap = document.createElement('div');
      barWrap.className = 'bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = Math.max(0.4, Math.min(100, (node.sizeBytes / totalBytes) * 100)) + '%';
      barWrap.append(bar);
      sizeCell.append(barWrap);

      const pctCell = document.createElement('div');
      pctCell.className = 'cell percent percent-col';
      pctCell.textContent = ((node.sizeBytes / totalBytes) * 100).toFixed(1) + '%';

      const decisionCell = document.createElement('div');
      decisionCell.className = 'cell decision ' + node.decision;
      decisionCell.textContent = (icons[node.decision] || '•') + ' ' + (labels[node.decision] || node.decision);

      row.append(nameCell, sizeCell, pctCell, decisionCell);
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

  document.getElementById('expand').onclick = () => { expanded.clear(); expandToDepth(roots, 0, 2); render(); };
  document.getElementById('collapse').onclick = () => { expanded.clear(); render(); };
  search.addEventListener('input', render);
  decisionFilter.addEventListener('change', render);

  expandToDepth(roots, 0, 1);
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
