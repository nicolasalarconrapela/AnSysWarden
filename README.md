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
./ansys bridge token
./ansys bridge serve
./ansys bridge ping
./ansys bridge classify <ruta>
./ansys logs
./ansys logs --raw
./ansys ai stop
```

## Puente PC ↔ móvil

El bridge permite que el PC haga el trabajo pesado de inspección del sistema de archivos y que el móvil use Gemma/Ollama como cerebro de clasificación.

En esta versión no se transfieren archivos ni su contenido. El PC genera un perfil local con tamaño, número de archivos/directorios, fechas y resumen de extensiones; únicamente esos metadatos y la ruta se envían al móvil.

Flujo:

```text
PC                              S25 Ultra / Termux
scan/perfil ── metadatos ─────> AnSys Bridge ──> Ollama/Gemma
            <── clasificación ─              <── resultado
```

Ollama sigue escuchando únicamente en `127.0.0.1`. El que se expone en la LAN es el bridge autenticado.

### 1. Crear un token compartido

En uno de los dos dispositivos:

```bash
./ansys bridge token
```

Guarda el valor generado y configura exactamente el mismo token en móvil y PC:

```bash
export ANSYSWARDEN_BRIDGE_TOKEN='TOKEN_GENERADO'
```

### 2. Arrancar el móvil

Con PC y móvil en la misma red local:

```bash
./ansys ai start
export ANSYSWARDEN_BRIDGE_TOKEN='TOKEN_GENERADO'
./ansys bridge serve
```

Por defecto el bridge escucha en el puerto `8787`.

### 3. Configurar el PC

Sustituye `IP_DEL_MOVIL` por la dirección local del S25:

```bash
export ANSYSWARDEN_BRIDGE_TOKEN='TOKEN_GENERADO'
export ANSYSWARDEN_BRIDGE_URL='http://IP_DEL_MOVIL:8787'
```

Comprueba la conexión:

```bash
./ansys bridge ping
```

### 4. Clasificar en el móvil una ruta del PC

Desde el PC:

```bash
./ansys bridge classify ~/.gradle/caches
```

El PC inspecciona la ruta localmente, envía solo el perfil al móvil y recibe la clasificación. Ningún archivo se borra ni se transfiere.

## Dependencias TypeScript

Las dependencias solo necesitan instalarse una vez o cuando cambie `package.json`:

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
ANSYSWARDEN_BRIDGE_TOKEN=<token compartido>
ANSYSWARDEN_BRIDGE_URL=http://<ip-movil>:8787
ANSYSWARDEN_BRIDGE_HOST=0.0.0.0
ANSYSWARDEN_BRIDGE_PORT=8787
```

## Trazabilidad

La consola está pensada para lectura humana. En paralelo, los comandos TypeScript escriben eventos estructurados en:

```text
.ansyswarden/logs/<run-id>.jsonl
```

Ver logs humanos y de Ollama:

```bash
./ansys logs
```

Ver las trazas JSONL completas:

```bash
./ansys logs --raw
```

## Validación recomendada

Antes de considerar una modificación validada:

```bash
npm install
npm run typecheck
./ansys ai status
./ansys ai test
./ansys bridge ping
```

Para probar el flujo completo desde el PC:

```bash
./ansys bridge classify <ruta-local-del-pc>
```

No se considera validado el bridge hasta ejecutar estas comprobaciones en los dos dispositivos reales.
