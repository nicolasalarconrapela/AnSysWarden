# AnSysWarden

AnSysWarden es un clasificador local y conservador para identificar cachés y artefactos de desarrollo potencialmente recuperables sin permitir que la IA borre archivos.

## Principio de seguridad

La clasificación sigue este orden:

1. Reglas deterministas para rutas conocidas.
2. Gemma mediante Ollama solo para casos ambiguos.
3. Si la IA falla o devuelve una respuesta inválida, el resultado es `REVIEW_REQUIRED`.

Clasificaciones:

- `SAFE_CACHE`: candidato regenerable.
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
Gemma / Ollama analiza
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
└── results/
    └── <scan-id>.result.json
```

El formato se versiona mediante `schema`, empezando por `ansyswarden.scan.v1`.

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
  "source": "drup",
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

La salida de la herramienta externa (por ejemplo `drup`) debe transformarse primero a este contrato; el backend no depende de esa herramienta concreta.

## Interfaz principal

La interfaz diaria es el comando `./ansys`.

Comandos principales:

```bash
./ansys ai start
./ansys ai status
./ansys ai test
./ansys doctor
./ansys classify ~/.gradle/caches
./ansys inspect ~/.gradle/caches
./ansys scan ~ --min-mb 50
./ansys backend serve
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
ANSYSWARDEN_MODEL=gemma3:1b
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

## Validación pendiente

Antes de considerar esta rama validada en ejecución:

```bash
npm install
npm run typecheck
./ansys backend serve
```

Después debe comprobarse desde otro dispositivo que `/api/health`, `/api/scans/latest` y el envío de resultados funcionan correctamente.
