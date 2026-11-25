import assert from 'node:assert/strict';
import { parseDustCaptureArguments } from '../../src/dust/scan-options';
import { buildInventoryManifest, INVENTORY_MANIFEST_SCHEMA } from '../../src/dust/inventory-manifest';
import { TREE_INDEX_SCHEMA, type TreeScanMetadata } from '../../src/core/inventory/tree-types';

function parseTests(): void {
  const base = parseDustCaptureArguments('scan', ['data/pc-tree-fixture']);
  assert.equal(base.mode, 'inventory');
  assert.equal(base.rootPath, 'data/pc-tree-fixture');
  assert.equal(base.allocated, true);
  assert.equal(base.htmlPath, null);
  assert.equal(base.days, 180);

  const full = parseDustCaptureArguments('inventory', [
    'data/pc-tree-fixture', '--no-allocated', '--days', '90',
    '--html', 'inventario.html', '--out', 'indice.jsonl', '--strict',
  ]);
  assert.equal(full.mode, 'inventory');
  assert.equal(full.allocated, false);
  assert.equal(full.days, 90);
  assert.equal(full.htmlPath, 'inventario.html');
  assert.equal(full.outputPath, 'indice.jsonl');
  assert.equal(full.strict, true);

  const alias = parseDustCaptureArguments('scan', ['/fixture', '--output', 'captura.jsonl', '--html']);
  assert.equal(alias.outputPath, 'captura.jsonl');
  assert.equal(alias.htmlPath, '');

  const old = parseDustCaptureArguments('scan', ['/fixture', '--legacy', '--full', '--depth', '3']);
  assert.equal(old.mode, 'legacy');
  assert.equal(old.legacy.full, true);
  assert.equal(old.legacy.depth, 3);
  assert.equal(parseDustCaptureArguments('scan', ['/fixture', '--min-size', '50M']).mode, 'legacy');
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--unknown']), /desconocida/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--days', '0']), /inválido/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--days', 'not-a-number']), /inválido/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--depth']), /Falta/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--out']), /Falta/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--out', 'a', '--output', 'b']), /duplicada/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', '--legacy', '--strict']), /mezclar/);
  assert.throws(() => parseDustCaptureArguments('inventory', ['/fixture', '--depth', '2']), /no acepta/);
  assert.throws(() => parseDustCaptureArguments('scan', ['/fixture', 'otra-carpeta']), /exactamente/);
}

function manifestTests(): void {
  const metadata: TreeScanMetadata = {
    schema: TREE_INDEX_SCHEMA,
    id: 'tree-20261118070000-1234abcd',
    createdAt: '2026-11-18T07:00:00.000Z',
    rootPath: '/fixture',
    computer: 'pc-fixture',
    platform: 'test',
    indexPath: '/fixture/snapshot.jsonl',
    entries: 41,
    files: 19,
    directories: 22,
    symlinks: 0,
    others: 0,
    errors: 0,
    sizeBytes: 16400,
  };
  const input = {
    metadata,
    agePath: '/reports/age.json',
    activityPath: '/reports/activity.json',
    allocation: null,
    allocatedRequested: false,
    warnings: [] as string[],
  };
  const skipped = buildInventoryManifest(input);
  assert.equal(skipped.schema, INVENTORY_MANIFEST_SCHEMA);
  assert.equal(skipped.status, 'COMPLETE');
  assert.equal(skipped.coverage.entries, 41);
  assert.equal(skipped.space.logicalBytes, 16400);
  assert.equal(skipped.space.allocated, 'SKIPPED');
  assert.equal(skipped.space.allocatedBytesMeasured, null);

  const partial = buildInventoryManifest({
    ...input, metadata: { ...metadata, errors: 2 },
    allocatedRequested: true,
    warnings: ['Dos rutas inaccesibles'],
  });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.space.allocated, 'UNAVAILABLE');
  assert.equal(partial.warnings.length, 1);
}

parseTests();
manifestTests();
console.log('✓ [PASS] Dust scan options + inventory manifest: contrato correcto (sin acceder al disco).');
