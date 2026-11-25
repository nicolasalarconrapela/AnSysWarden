#!/usr/bin/env node
/**
 * Entrada compatible para los comandos antiguos de AnSysWarden.
 * Mantiene la fixture previa en data/pc-tree-fixture.
 * Para pruebas nuevas, usar tests/fixtures/inventario/generate-pc-fixtures.mjs.
 */
process.env.ANSYSWARDEN_TEST_FIXTURE_LEGACY = '1';
await import('../tests/fixtures/inventario/generate-pc-fixtures.mjs');
