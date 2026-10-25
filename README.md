# AnSysWarden

AnSysWarden es un clasificador local y conservador para identificar cachés y artefactos de desarrollo potencialmente recuperables sin permitir que la IA borre archivos.

## Principio de seguridad

La clasificación sigue este orden:

1. Reglas deterministas para rutas conocidas.
2. Gemma mediante Ollama aporta evidencia solo para casos ambiguos.
3. Solo las reglas locales pueden autorizar `SAFE_CACHE`; la IA puede terminar en protección o revisión.
4. Si la IA falla o devuelve una respuesta inválida, el resultado es `REVIEW_REQUIRED`.

Clasificaciones:

- `SAFE_CACHE`: candidato regenerable autorizado por reglas locales.
- `REVIEW_REQUIRED`: requiere revisión humana.
- `USER_DATA`: datos potencialmente únicos o personales.

La CLI actual es estrictamente de solo lectura y no contiene operaciones de borrado.

## Arquitectura PC ↔ móvil

El ordenador es la fuente de verdad y aloja el backend de AnSysWarden. El móvil no expone ningún servidor.

Flujo:

```text
scanner / fuente externa
        ↓
normalización AnSysWarden
        ↓
JSON persistido en el PC
        ↓
backend HTTP del PC
        ↓
móvil consume el JSON
        ↓
Gemma / Ollama aporta evidencia
        ↓
resultado devuelto por API
        ↓
PC valida y persiste el resultado
```

Los archivos reales del PC no se transfieren al móvil. Solo viajan los JSON generados expresamente por AnSysWarden.

Los datos persistidos viven por defecto en:

```text
.ansyswarden/backend/data/
├── scans/
│   ├── latest.json
│   └── <scan-id>.json
├── ai-inputs/
│   ├── latest.ai.json
│   └── <scan-id>.ai.json
└── results/
    └── <scan-id>.result.json
```

Los contratos se versionan mediante `schema`, empezando por `ansyswarden.scan.v1`, `ansyswarden.ai-input.v1` y `ansyswarden.result.v1`.

### Backend del PC

Arranque:

```bash
export ANSYSWARDEN_API_TOKEN='una-clave-larga'
./ansys backend serve
```

Por defecto escucha en `0.0.0.0:8787` y exige `Authorization: Bearer <token>`.

Endpoints iniciales:

```text
GET  /api/health
GET  /api/scans
GET  /api/scans/latest
GET  /api/scans/:id
GET  /api/scans/:id/ai-input
GET  /api/ai-inputs/latest
POST /api/scans
POST /api/scans/:id/results
GET  /api/scans/:id/results
```

### Crear un JSON de escaneo

El backend acepta un documento ya normalizado mediante:

```text
POST /api/scans
```

Ejemplo:

```json
{
  "schema": "ansyswarden.scan.v1",
  "id": "scan-a81f",
  "createdAt": "2026-10-24T12:47:00+02:00",
  "source": "dust",
  "computer": "NICO-PC",
  "entries": [
    {
      "path": "C:\\Users\\nico\\.gradle\\caches",
      "sizeBytes": 8452342341,
      "files": 192304,
      "directories": 12537
    }
  ]
}
```

La salida de una herramienta externa debe transformarse al contrato de AnSysWarden; el backend no depende de una fuente concreta.

## Interfaz principal

La interfaz diaria es el comando `./ansys`.

Comandos principales:

```bash
./ansys ai start
./ansys ai status
./ansys ai test
./ansys ai models
./ansys ai pull-mobile-candidate
./ansys doctor
./ansys classify ~/.gradle/caches
./ansys inspect ~/.gradle/caches
./ansys scan ~ --min-mb 50
./ansys dust status
./ansys dust scan ~ --depth 5 --min-size 50M
./ansys backend serve
./ansys test tree
./ansys test context
./ansys test candidates
./ansys test models
./ansys test mobile-models
./ansys logs
./ansys logs --raw
./ansys ai stop
```

## Dependencias TypeScript

La implementación interna está escrita en TypeScript. Las dependencias solo necesitan instalarse una vez o cuando cambie `package.json`:

```bash
npm install
```

## Gestión de Ollama

Arrancar:

```bash
./ansys ai start
```

Estado:

```bash
./ansys ai status
```

Prueba de inferencia:

```bash
./ansys ai test
```

Modelo móvil principal:

```bash
./ansys ai models
./ansys ai pull-mobile-candidate
```

Detener:

```bash
./ansys ai stop
```

## Diagnóstico

```bash
./ansys doctor
```

## Clasificar una ruta

```bash
./ansys classify ~/.gradle/caches
```

## Inspección contextual

```bash
./ansys inspect ~/.gradle/caches
```

## Escaneo

```bash
./ansys scan ~ --min-mb 50
```

El escaneo identifica candidatos pesados para revisión; no elimina nada.

Variables opcionales:

```bash
ANSYSWARDEN_MODEL=gemma4:e2b
OLLAMA_HOST_URL=http://127.0.0.1:11434
ANSYSWARDEN_LOG_FILE=/ruta/personalizada/traza.jsonl
ANSYSWARDEN_API_TOKEN=clave-larga
ANSYSWARDEN_BACKEND_HOST=0.0.0.0
ANSYSWARDEN_BACKEND_PORT=8787
ANSYSWARDEN_BACKEND_DATA_DIR=/ruta/al/backend/data
```

## Trazabilidad

Las trazas estructuradas se escriben en:

```text
.ansyswarden/logs/<run-id>.jsonl
```

## Validación

Antes de considerar la integración validada en ejecución:

```bash
npm install
npm run typecheck
./ansys test rules
./ansys test tree
./ansys test context
./ansys test candidates
./ansys test safety
./ansys ai models
./ansys backend serve
```

Después debe comprobarse desde el otro dispositivo que `/api/health`, `/api/scans/latest`, `/api/ai-inputs/latest` y el envío de resultados funcionan correctamente.
