import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Classification = 'SAFE_CACHE' | 'REVIEW_REQUIRED' | 'USER_DATA';
type ClassificationSource = 'rule' | 'ai' | 'fallback';

type ScanDocument = {
  id: string;
  createdAt: string;
  source: string;
  computer: string;
  entries: Array<{ path: string; sizeBytes: number }>;
};

type ScanResultItem = {
  path: string;
  classification: Classification;
  confidence: number;
  reason: string;
  source: ClassificationSource;
};

type ScanResultDocument = {
  scanId: string;
  worker: string;
  model: string;
  createdAt: string;
  results: ScanResultItem[];
};

const API_BASE = import.meta.env.VITE_ANSYSWARDEN_API_BASE ?? '';
const API_TOKEN = import.meta.env.VITE_ANSYSWARDEN_API_TOKEN ?? '';

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function App() {
  const [scan, setScan] = useState<ScanDocument | null>(null);
  const [result, setResult] = useState<ScanResultDocument | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const latest = await api<ScanDocument>('/api/scans/latest');
      setScan(latest);
      try {
        setResult(await api<ScanResultDocument>(`/api/scans/${encodeURIComponent(latest.id)}/results`));
      } catch {
        setResult(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const sizeByPath = useMemo(() => new Map(scan?.entries.map((entry) => [entry.path, entry.sizeBytes]) ?? []), [scan]);
  const deleteItems = result?.results.filter((item) => item.classification === 'SAFE_CACHE') ?? [];
  const reviewItems = result?.results.filter((item) => item.classification === 'REVIEW_REQUIRED') ?? [];
  const selectedBytes = deleteItems.reduce((sum, item) => selected.has(item.path) ? sum + (sizeByPath.get(item.path) ?? 0) : sum, 0);

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">ANSYSWARDEN</div>
          <h1>Limpieza segura</h1>
          <p>La IA recomienda. El PC valida. Tú decides.</p>
        </div>
        <button className="ghost" onClick={() => void load()} disabled={loading}>Actualizar</button>
      </header>

      {error && <div className="banner error">No se pudo conectar con el backend: {error}</div>}
      {!API_TOKEN && <div className="banner warning">Falta VITE_ANSYSWARDEN_API_TOKEN. Configúralo para leer el backend.</div>}

      <section className="stats">
        <article><span>Estado</span><strong>{loading ? 'Cargando…' : error ? 'Sin conexión' : 'Conectado'}</strong></article>
        <article><span>Último scan</span><strong>{scan ? new Date(scan.createdAt).toLocaleString() : '—'}</strong></article>
        <article><span>Eliminar</span><strong>{deleteItems.length}</strong></article>
        <article><span>Revisar</span><strong>{reviewItems.length}</strong></article>
      </section>

      <section className="columns">
        <Panel title="Eliminar" subtitle="Solo elementos autorizados como SAFE_CACHE" tone="safe" count={deleteItems.length}>
          {deleteItems.length === 0 ? <Empty text="No hay cachés autorizadas para eliminar." /> : deleteItems.map((item) => (
            <ItemCard key={item.path} item={item} size={sizeByPath.get(item.path) ?? 0} selected={selected.has(item.path)} onToggle={() => toggle(item.path)} selectable />
          ))}
        </Panel>

        <Panel title="Revisar" subtitle="La evidencia no permite borrado automático" tone="review" count={reviewItems.length}>
          {reviewItems.length === 0 ? <Empty text="No hay elementos pendientes de revisión." /> : reviewItems.map((item) => (
            <ItemCard key={item.path} item={item} size={sizeByPath.get(item.path) ?? 0} selected={false} onToggle={() => {}} selectable={false} />
          ))}
        </Panel>
      </section>

      <footer className="actionbar">
        <div>
          <span>Seleccionado</span>
          <strong>{formatBytes(selectedBytes)}</strong>
          <small>{selected.size} elemento{selected.size === 1 ? '' : 's'}</small>
        </div>
        <button className="primary" disabled title="Se habilitará cuando exista un endpoint de borrado seguro">Eliminar seleccionados</button>
      </footer>
    </main>
  );
}

function Panel({ title, subtitle, tone, count, children }: React.PropsWithChildren<{ title: string; subtitle: string; tone: 'safe' | 'review'; count: number }>) {
  return <section className={`panel ${tone}`}>
    <div className="panelHead"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="count">{count}</span></div>
    <div className="list">{children}</div>
  </section>;
}

function ItemCard({ item, size, selected, onToggle, selectable }: { item: ScanResultItem; size: number; selected: boolean; onToggle: () => void; selectable: boolean }) {
  return <article className={`item ${selected ? 'selected' : ''}`}>
    {selectable && <input aria-label={`Seleccionar ${basename(item.path)}`} type="checkbox" checked={selected} onChange={onToggle} />}
    <div className="itemBody">
      <div className="itemTop"><strong>{basename(item.path)}</strong><span>{formatBytes(size)}</span></div>
      <code>{item.path}</code>
      <p>{item.reason}</p>
      <div className="meta"><span>{item.source}</span><span>{Math.round(item.confidence * 100)}% confianza</span></div>
    </div>
  </article>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
