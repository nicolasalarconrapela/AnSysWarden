# AnSysWarden

AnSysWarden es un clasificador local y conservador para identificar cachés y artefactos de desarrollo potencialmente recuperables sin permitir que la IA borre archivos.

## Principio de seguridad

La clasificación sigue este orden:

1. Reglas deterministas para rutas conocidas.
2. Gemma 2 2B mediante Ollama solo para casos ambiguos.
3. Si la IA falla o devuelve una respuesta inválida, el resultado es `REVIEW_REQUIRED`.

Clasificaciones:

- `SAFE_CACHE`: candidato regenerable.
- `REVIEW_REQUIRED`: requiere revisión humana.
- `USER_DATA`: datos potencialmente únicos o personales.

La CLI actual es estrictamente de solo lectura y no contiene operaciones de borrado.

## Preparar IA móvil

```bash
chmod +x scripts/setup-mobile-ai.sh
./scripts/setup-mobile-ai.sh
```

## Instalar dependencias TypeScript

```bash
npm install
```

## Diagnóstico local de Ollama

```bash
npm run doctor
```

El comando comprueba `http://127.0.0.1:11434`, muestra los modelos disponibles y genera una traza JSONL de la ejecución.

## Clasificar una ruta

```bash
npm run classify -- ~/.gradle/caches
```

O directamente:

```bash
npx tsx src/cli.ts classify ~/.gradle/caches
```

Variables opcionales:

```bash
ANSYSWARDEN_MODEL=gemma2:2b
OLLAMA_HOST_URL=http://127.0.0.1:11434
ANSYSWARDEN_LOG_FILE=/ruta/personalizada/traza.jsonl
```

## Trazabilidad

Cada ejecución tiene un `Run ID` y escribe eventos JSONL en:

```text
.ansyswarden/logs/<run-id>.jsonl
```

La consola está pensada para lectura humana. El JSONL conserva información técnica útil para análisis automático o para compartir la ejecución con otra IA: timestamp, nivel, evento, duración, modelo, arquitectura, ruta, clasificación, confianza y errores técnicos.

Ejemplos:

```bash
npm run doctor
npm run classify -- ~/NikeDevs_Down/AnSysWarden
cat .ansyswarden/logs/*.jsonl
```

Para inspeccionar solo los últimos eventos:

```bash
tail -n 20 .ansyswarden/logs/*.jsonl
```

## Comprobar tipos

```bash
npm run typecheck
```

Antes de considerar una modificación validada en el S25 Ultra, ejecutar como mínimo:

```bash
git pull
npm install
npm run typecheck
npm run doctor
npm run classify -- ~/.gradle/caches
```
