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
./ansys ai bootstrap
```

`./ansys ai bootstrap` prepara el entorno móvil, instala/verifica Ollama, descarga `gemma2:2b` y ejecuta una prueba nativa y otra desde Node.js/TypeScript.

Comandos principales:

```bash
./ansys ai bootstrap
./ansys ai start
./ansys ai status
./ansys ai test
./ansys doctor
./ansys classify ~/.gradle/caches
./ansys inspect ~/.gradle/caches
./ansys scan ~ --min-mb 50
./ansys logs
./ansys logs --raw
./ansys ai stop
```

## Dependencias TypeScript

La implementación interna de algunos comandos está escrita en TypeScript. Las dependencias solo necesitan instalarse una vez o cuando cambie `package.json`:

```bash
npm install
```

Esto no arranca Ollama ni forma parte del uso diario de la IA.

## Gestión de Ollama

Preparación inicial completa:

```bash
./ansys ai bootstrap
```

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

## Inspección contextual

```bash
./ansys inspect ~/.gradle/caches
```

Recoge contexto útil de una ruta sin modificar archivos para ayudar a decidir si es caché, artefacto regenerable o contenido que requiere revisión.

## Escaneo

```bash
./ansys scan ~ --min-mb 50
```

El escaneo identifica candidatos pesados para revisión; no elimina nada.

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

Para una instalación nueva o después de rehacer el entorno Debian/Termux, ejecuta antes:

```bash
./ansys ai bootstrap
```

`npm install` y `npm run typecheck` son tareas de preparación/desarrollo. El manejo diario de Ollama y AnSysWarden se realiza mediante `./ansys`.
