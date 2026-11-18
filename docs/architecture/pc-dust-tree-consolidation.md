# PC: consolidación Dust → inventario → Tree

## Decisión

El comando canónico del PC es `./ansys dust scan <ruta>`.
Realiza un recorrido nativo exhaustivo y genera un índice JSONL de archivos y
carpetas. No depende de que el ejecutable externo `dust` enumere todos los
archivos. El inventario conserva tamaños lógicos y las tres marcas de tiempo
en la medida en que el sistema de archivos las proporcione.

`./ansys dust inventory <ruta>` se mantiene como alias compatible del nuevo
comando de captura. La salida original de Dust destinada al backend y a la IA
sigue disponible con `./ansys dust scan <ruta> --legacy`, o indicando las
opciones históricas `--depth`, `--min-size`, `--full`,
`--ai-depth` o `--ai-max-entries`.

**Cambio de comportamiento deliberado:** `dust scan <ruta>` sin opciones
ahora captura inventario completo. Los consumidores que dependan del JSON
antiguo `ansyswarden.scan.v1` deben usar `--legacy`.

## Persistencia y cobertura

- Índice `ansyswarden.tree-index.v1` (JSONL), sin migración destructiva.
- Metadatos de Tree originales (`<id>.meta.json` y puntero `latest.json`).
- Manifiesto derivado `ansyswarden.inventory-manifest.v1` en
  `.ansyswarden/tree/manifests/<id>.json`.
- Informes derivados de edad, actividad y espacio asignado en archivos
  separados. Ninguna clasificación de IA altera el índice.
- `status: COMPLETE` significa que el recorrido terminó con cero errores
  reportados, no que el tamaño físico se haya medido completamente. Los
  errores de lectura marcan `status: PARTIAL`.
- `space.allocated`: `COMPLETE`, `PARTIAL`, `SKIPPED` o `UNAVAILABLE`.
  `UNAVAILABLE` no es cero bytes; `--strict` permite señalar esa situación.
- `atime` no demuestra uso humano, y `birthtime` tiene semántica variable
  según sistema operativo y sistema de archivos.
- El espacio asignado no debe interpretarse como espacio recuperable.

El inventario y el HTML no borran ni modifican archivos del usuario. Las
rutas inaccesibles se registran como errores, no se ocultan como ausencia.

## Tree: visualización independiente

```bash
./ansys tree view --latest --out ultimo.html
./ansys tree view --scan-id tree-YYYYMMDDHHMMSS-xxxxxxxx --out antiguo.html
./ansys tree view --index "/ruta/escaneo.jsonl" --out indice.html
./ansys tree export --latest --format html --out ultimo.html
./ansys tree view --scan "data/pc-tree-fixture" --no-allocated --out nuevo.html
```

`tree view --scan` solicita al subsistema Dust el mismo snapshot completo.
`tree scan`, `tree age`, `tree activity`, `tree allocated` y
`tree html` permanecen como entradas de compatibilidad.
La implementación de análisis se aloja bajo `src/dust/analysis`; los archivos
antiguos `src/tree/tree-*.ts` reexportan sus APIs originales.

## Comandos recomendados de validación (ejecución manual)

```bash
npm run typecheck
./node_modules/.bin/tsx src/tests/pc-dust-scan-contract-cli.ts
./node_modules/.bin/tsx src/tests/pc-inventory-boundary-cli.ts
node data/generate-pc-fixtures.mjs
./ansys dust scan "data/pc-tree-fixture" --no-allocated --html inventario.html
./ansys tree view --latest --out ultimo.html
./ansys tree view --scan "data/pc-tree-fixture" --no-allocated --out nuevo.html
```

Los datos de prueba esperan **19 archivos, 22 carpetas (incluida la raíz),
41 entradas y cero errores**. Comprobar también las tres marcas de tiempo y
que no se dupliquen los recuentos.

Estos comandos generan índices e informes locales; deben ejecutarse
únicamente en un entorno de prueba. No se ejecutaron desde la integración
GitHub del cambio.
