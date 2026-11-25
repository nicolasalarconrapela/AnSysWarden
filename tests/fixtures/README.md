# Datos ficticios de pruebas

Estos datos sirven para comprobar el proyecto **sin escanear carpetas personales**.

- `backend-smoke.json`: documentos JSON ficticios para el smoke test del backend.
- `inventario/generate-pc-fixtures.mjs`: generador/validador de una carpeta
  ficticia (19 archivos, 22 directorios, 41 entradas).

```bash
node tests/fixtures/inventario/generate-pc-fixtures.mjs
node tests/fixtures/inventario/generate-pc-fixtures.mjs --verify
```

Esto crea `tests/fixtures/inventario/pc-tree-fixture/`, ignorada en Git.
Los archivos son de prueba. El generador verifica contenidos y **rechaza
sobrescribir un archivo preexistente con datos diferentes**.

Compatibilidad: el comando anterior `node data/generate-pc-fixtures.mjs`
sigue utilizando su ubicación original `data/pc-tree-fixture/`.
