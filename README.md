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

## Interfaz principal en el móvil

La interfaz diaria es el comando `./ansys`. No es necesario usar `npm` para arrancar, parar o probar Ollama.

Primera vez:

```bash
chmod +x ansys
```

Comandos principales:

```bash
./ansys ai start
./ansys ai status
./ansys ai test
./ansys doctor
./ansys classify ~/.gradle/caches
./ansys logs
./ansys logs --raw
./ansys ai stop
```

## Preparar IA móvil

Si Ollama y Gemma todavía no están instalados:

```bash
chmod +x scripts/setup-mobile-ai.sh
./scripts/setup-mobile-ai.sh
```

Después, el ciclo normal se gestiona con `./ansys ai ...`.

## Dependencias TypeScript

La implementación interna de algunos comandos está escrita en TypeScript. Las dependencias solo necesitan instalarse una vez o cuando cambie `package.json`:

```bash
npm install
```

Esto no arranca Ollama ni forma parte del uso diario de la IA.

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

Comprueba el Ollama local, el modelo configurado y genera una traza JSONL de la ejecución.

## Clasificar una ruta

```bash
./ansys classify ~/.gradle/caches
```

Variables opcionales:

```bash
ANSYSWARDEN_MODEL=gemma2:2b
OLLAMA_HOST_URL=http://127.0.0.1:11434
ANSYSWARDEN_LOG_FILE=/ruta/personalizada/traza.jsonl
```

## Trazabilidad

La consola está pensada para lectura humana. En paralelo, los comandos TypeScript escriben eventos estructurados en:

```text
.ansyswarden/logs/<run-id>.jsonl
```

Estos eventos conservan timestamp, nivel, evento, duración, modelo, arquitectura, ruta, clasificación, confianza y errores técnicos.

Ver logs humanos y de Ollama:

```bash
./ansys logs
```

Ver las trazas JSONL completas:

```bash
./ansys logs --raw
```

## Testing en el S25 Ultra

Antes de considerar una modificación validada:

```bash
git pull
chmod +x ansys
npm install
npm run typecheck
./ansys ai status
./ansys ai test
./ansys doctor
./ansys classify ~/.gradle/caches
./ansys logs --raw
```

`npm install` y `npm run typecheck` son tareas de preparación/desarrollo. El manejo diario de Ollama y AnSysWarden se realiza mediante `./ansys`.
