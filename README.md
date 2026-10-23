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
```

## Comprobar tipos

```bash
npm run typecheck
```
