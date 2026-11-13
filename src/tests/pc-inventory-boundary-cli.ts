import assert from 'node:assert/strict';
import { CreateTreeInventory } from '../application/tree/create-tree-inventory';
import type { TreeInventoryScannerPort } from '../application/tree/ports/tree-inventory-scanner.port';
import { TREE_INDEX_SCHEMA, type TreeScanMetadata, type TreeScanOptions } from '../core/inventory/tree-types';

async function main(): Promise<void> {
  const metadata: TreeScanMetadata = {
    schema: TREE_INDEX_SCHEMA,
    id: 'fixture-scan',
    createdAt: '2026-11-13T00:00:00.000Z',
    rootPath: '/fixture',
    computer: 'fixture-pc',
    platform: 'test',
    indexPath: '/fixture/index.jsonl',
    entries: 2,
    files: 1,
    directories: 1,
    symlinks: 0,
    others: 0,
    errors: 0,
    sizeBytes: 42,
  };
  let calls = 0;
  let receivedRoot = '';
  let receivedOptions: TreeScanOptions | undefined;
  const fakeScanner: TreeInventoryScannerPort = {
    async scan(rootPath, options) {
      calls += 1;
      receivedRoot = rootPath;
      receivedOptions = options;
      return metadata;
    },
  };
  const useCase = new CreateTreeInventory(fakeScanner);
  const onProgress = () => undefined;
  const result = await useCase.execute('/fixture', { progressEvery: 2, onProgress });

  assert.equal(calls, 1);
  assert.equal(receivedRoot, '/fixture');
  assert.equal(receivedOptions?.progressEvery, 2);
  assert.equal(receivedOptions?.onProgress, onProgress);
  assert.strictEqual(result, metadata);
  assert.equal(result.schema, 'ansyswarden.tree-index.v1');
  console.log('[PASS] PC inventory use case forwards data through the port without filesystem access.');
}

main().catch((error: unknown) => {
  console.error('[FAIL] PC inventory boundary:', error);
  process.exitCode = 1;
});
