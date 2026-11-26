# Pruebas de AnSysWarden — encuentra lo que necesitas

Este directorio reúne las **implementaciones** de los tests por finalidad. Cada
categoría separa el código que comprueba algo de los datos ficticios y los
resultados. Trabaja siempre desde la raíz del repositorio.

## Primera comprobación (sin modificar nada)

```bash
node tests/01-contratos/validar-estructura.mjs
npm run typecheck
```

El primer comando revisa rutas, accesos compatibles, dependencias y las
carpetas de resultados **solo leyendo archivos**. El segundo verifica TypeScript.
No sustituyen a los tests funcionales.

## ¿Qué quieres comprobar?

| Si necesitas saber… | Carpeta | Qué ejecutar | ¿Requiere servicios? |
| --- | --- | --- | --- |
| Si los parámetros y los contratos siguen siendo válidos | [01-contratos](01-contratos/) | `./node_modules/.bin/tsx tests/01-contratos/pc-dust-scan-contract-cli.ts` | No |
| Si el escáner está bien separado y los inventarios son coherentes | [02-inventario](02-inventario/) | `./ansys test overlap` y [fixture reproducible](fixtures/inventario/) | No |
| Si Tree respeta sus reglas o si el HTML se ve bien | [03-visor-html](03-visor-html/) | `./ansys test tree` + inspección visual | No para reglas; HTML se revisa en navegador |
| Si las reglas de protección se mantienen | [04-seguridad](04-seguridad/) | `./ansys test rules` | No |
| Si los candidatos y los modelos de IA responden | [05-ia](05-ia/) | `./ansys test candidates` / `./ansys test models` | Modelos: sí, requiere Ollama |
| Si PC, backend y móvil se comunican | [06-e2e](06-e2e/) | `./ansys test e2e --backend http://127.0.0.1:8787` | Sí, backend + worker |
| Si el entorno TypeScript sigue siendo válido | Todo el proyecto | `npm run typecheck` | No |

**También:** `./ansys test safety` comprueba barreras con casos de IA y necesita Ollama;
la parte de reglas deterministas se ejecuta sin modelo con `./ansys test rules`.
Para obtener la lista completa: `./ansys help test`.

## Revisión humana de Tree antes de IA

```bash
./node_modules/.bin/tsx tests/03-visor-html/tree-ai-review-cli.ts
./ansys tree ai-preview --latest --out revision_ia.html
```

El primer comando usa únicamente registros ficticios. El segundo crea una
página local para **revisar fichas anonimizadas**; no envía datos a IA.
Lee [las instrucciones del visor](03-visor-html/README.md).

## Recorrido recomendado sin archivos personales

1. Crear datos ficticios: `node tests/fixtures/inventario/generate-pc-fixtures.mjs`.
2. Comprobarlos: `node tests/fixtures/inventario/generate-pc-fixtures.mjs --verify`.
3. Generar una captura: `./ansys dust scan "tests/fixtures/inventario/pc-tree-fixture" --no-allocated`.
4. Comparar el JSONL con los datos esperados:
   `node tests/fixtures/inventario/generate-pc-fixtures.mjs --verify --index "<RUTA_JSONL_REAL>"`.
5. Crear HTML: `./ansys tree view --latest --out "tests/resultados/03-visor-html/visor_prueba.html"`.
6. Revisar visualmente la lista de [03-visor-html](03-visor-html/README.md).

**No pegues literalmente** `<RUTA_JSONL_REAL>`: sustitúyelo por la ruta indicada
por el escaneo. Los resultados reales del inventario siguen alojados en
`.ansyswarden/tree/`: índices, manifiestos y análisis no se han trasladado.

## Datos y resultados: tres ubicaciones diferentes

- **`tests/01-...` a `tests/06-...`**: código fuente de las pruebas; está versionado.
- **`tests/fixtures/`**: datos de entrada sintéticos y generadores; los archivos
  generados se ignoran en Git.
- **`tests/resultados/`**: ubicación para HTML, logs o informes que dirijas
  **expresamente** a una categoría mediante `--out` o redirección.
  No todos los tests generan archivos y ninguno los mueve aquí automáticamente.

La ruta `src/tests/` permanece solo como **compatibilidad** para los comandos
antiguos `./node_modules/.bin/tsx src/tests/<archivo>.ts`. No añadas nuevas
pruebas allí; el código real está en estas carpetas.

La ruta `data/generate-pc-fixtures.mjs` también sigue funcionando y continúa
trabajando con `data/pc-tree-fixture/` para no romper tus capturas anteriores.
Para pruebas nuevas, utiliza el generador que hay bajo `tests/fixtures/inventario/`.

## Seguridad y lectura de resultados

- Los tests no autorizan borrar ningún archivo personal ni ejecutar limpiezas.
- La creación de fixtures y la exportación de HTML **sí escriben** en sus
  destinos. Usa nombres distintos si quieres conservar ejecuciones previas.
- `SKIPPED` para espacio asignado significa **no medido**, no cero bytes.
- Las pruebas E2E requieren dispositivos y servicios reales: ejecútalas
  conscientemente, nunca como efecto secundario de consultar la ayuda.
