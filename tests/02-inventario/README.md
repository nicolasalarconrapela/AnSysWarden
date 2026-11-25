# 02 · Inventario y escáner

**Para qué sirve:** revisar la selección/solapamiento de candidatos del escáner
y, por separado, verificar el inventario real contra un árbol ficticio conocido.

```bash
./ansys test overlap
node tests/fixtures/inventario/generate-pc-fixtures.mjs
node tests/fixtures/inventario/generate-pc-fixtures.mjs --verify
./ansys dust scan "tests/fixtures/inventario/pc-tree-fixture" --no-allocated
```

Para comprobar **rutas, recuentos y bytes** hay que pasar también el índice real
obtenido del último comando:

```bash
node tests/fixtures/inventario/generate-pc-fixtures.mjs --verify --index "<RUTA_JSONL_REAL>"
```

El último argumento es un marcador: **sustituye esa cadena por la ruta real**.
La fixture esperada contiene 19 archivos, 22 directorios y 41 entradas.
No se toca ni se elimina el contenido personal del PC.
