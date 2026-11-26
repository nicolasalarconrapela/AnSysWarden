import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_REVIEW_SCHEMA, buildAiReview } from '../../src/tree/ai-review';
import { renderAiReviewHtml, saveAiReview } from '../../src/tree/ai-review-html';
import { TREE_INDEX_SCHEMA, type TreeIndexRecord, type TreeScanMetadata } from '../../src/core/inventory/tree-types';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ansys-tree-ai-review-'));
  const root = join(dir, 'inventario');
  const input = join(dir, 'test.jsonl');
  const record = (path: string, type: 'directory' | 'file', depth: number, sizeBytes = 0): TreeIndexRecord => ({
    record: 'entry', path, name: path.split(/[\\/]/).pop() || path,
    type, depth, sizeBytes, mtimeMs: 1_700_000_000_000, atimeMs: 1_700_000_000_000,
  });
  const build = join(root, 'build');
  const backup = join(root, 'backups');
  const keep = join(root, 'cache-KEEP-important');
  const data: TreeIndexRecord[] = [
    record(root, 'directory', 0),
    record(build, 'directory', 1),
    record(join(build, 'main.class'), 'file', 2, 20),
    { record: 'directory-summary', path: build, sizeBytes: 20, files: 1, directories: 0, errors: 0 },
    record(backup, 'directory', 1),
    record(join(backup, 'unique.txt'), 'file', 2, 50),
    { record: 'directory-summary', path: backup, sizeBytes: 50, files: 1, directories: 0, errors: 0 },
    record(keep, 'directory', 1),
    record(join(keep, 'cache.bin'), 'file', 2, 30),
    { record: 'directory-summary', path: keep, sizeBytes: 30, files: 1, directories: 0, errors: 0 },
    { record: 'directory-summary', path: root, sizeBytes: 100, files: 3, directories: 3, errors: 0 },
  ];
  const metadata: TreeScanMetadata = {
    schema: TREE_INDEX_SCHEMA, id: 'tree-20261126080000-1234abcd',
    createdAt: new Date(1_700_000_000_000).toISOString(),
    rootPath: root, indexPath: input, computer: 'fixture', platform: 'test',
    entries: 7, files: 3, directories: 4, symlinks: 0, others: 0, errors: 0, sizeBytes: 100,
  };
  try {
    await writeFile(input, data.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    const review = await buildAiReview(metadata);
    assert.equal(review.schema, AI_REVIEW_SCHEMA);
    assert.equal(review.totalDirectories, 4);
    assert.equal(review.totalFiles, 3);
    assert.equal(review.shown, 3);
    assert.equal(review.omitted, 0);
    assert.equal(review.complete, true);
    assert.equal(review.folders.find(f => f.relativePath === 'build')?.eligible, true);
    assert.equal(review.folders.find(f => f.relativePath === 'build')?.profile.folderKind, 'compilacion');
    assert.deepEqual(review.folders.find(f => f.relativePath === 'build')?.profile.extensions,
      [{ extension: 'binarios', files: 1, bytes: 20 }]);
    assert.equal(review.folders.find(f => f.relativePath === 'build')?.profile.newestMtimeMs, 1_700_000_000_000);
    assert.equal(review.folders.find(f => f.relativePath === 'backups')?.eligible, false);
    assert.equal(review.folders.find(f => f.relativePath === 'cache-KEEP-important')?.eligible, false);
    assert.ok(review.folders.every(f => /^[0-9a-f-]{36}$/.test(f.id)));

    const html = renderAiReviewHtml(review);
    assert.ok(html.includes('connect-src \'none\''));
    assert.ok(html.includes('requiresSeparateSendConfirmation:true'));
    assert.ok(html.includes('Nada se ha enviado'));
    assert.ok(!html.includes('fetch('));
    assert.ok(!html.includes('XMLHttpRequest'));

    // Volver a usar el mismo nombre no debe sustituir el HTML anterior.
    const existingHtml = join(dir, 'revision_ia.html');
    const secondHtml = join(dir, 'revision_ia_02.html');
    const privateDir = join(dir, 'private-maps');
    await writeFile(existingHtml, 'REVISION ANTERIOR, NO BORRAR', 'utf8');
    await writeFile(secondHtml, 'REVISION DOS, NO BORRAR', 'utf8');
    await assert.rejects(
      saveAiReview(review, existingHtml, privateDir),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Ya existe el archivo de revisión/);
        assert.match(error.message, /revision_ia_03\.html/);
        assert.match(error.message, /No se ha enviado ningún dato/);
        return true;
      },
    );
    assert.equal(await readFile(existingHtml, 'utf8'), 'REVISION ANTERIOR, NO BORRAR');
    assert.equal(await readFile(secondHtml, 'utf8'), 'REVISION DOS, NO BORRAR');
    assert.deepEqual(await readdir(privateDir), [], 'El mapa privado temporal debe limpiarse');

    // La captura de un vínculo o error debe impedir la aprobación global.
    const withError: TreeIndexRecord[] = data.slice(0, -1).concat([
      { record: 'error', path: join(root, 'no-access'), name: 'no-access', depth: 1, code: 'EACCES', message: 'denied' },
      { record: 'directory-summary', path: root, sizeBytes: 100, files: 3, directories: 3, errors: 1 },
    ]);
    await writeFile(input, withError.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    const partial = await buildAiReview({ ...metadata, errors: 1 });
    assert.equal(partial.complete, false);
    assert.ok(partial.folders.every(f => !f.eligible));

    await assert.rejects(buildAiReview(metadata), /no coinciden/);

    // Inyección en un nombre: no debe convertirse en código HTML.
    const injected = structuredClone(review);
    injected.folders[0].relativePath = '<img src=x onerror=alert(1)>';
    const escaped = renderAiReviewHtml(injected);
    assert.ok(!escaped.includes('<img src=x onerror=alert(1)>'));

    console.log('✓ [PASS] Tree -> revisión humana: lectura JSONL, protección, errores y HTML sin red');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error('✗ [FAIL] Tree AI human review:', error);
  process.exitCode = 1;
});
