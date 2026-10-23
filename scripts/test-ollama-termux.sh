#!/usr/bin/env bash
set -euo pipefail

MODEL="gemma2:2b"
OLLAMA_URL="http://127.0.0.1:11434"
LOG_FILE="ollama.log"
TEST_TS="test-ai.ts"

log() {
  printf '\n[AnSysWarden] %s\n' "$1"
}

fail() {
  printf '\n[AnSysWarden][ERROR] %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl no está instalado."
command -v sh >/dev/null 2>&1 || fail "No se encontró un shell compatible."

if ! command -v ollama >/dev/null 2>&1; then
  log "Ollama no está instalado. Instalando..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

command -v ollama >/dev/null 2>&1 || fail "La instalación de Ollama no dejó el binario disponible en PATH."

if ! curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  log "Levantando ollama serve en segundo plano..."
  nohup ollama serve > "$LOG_FILE" 2>&1 &

  for _ in $(seq 1 30); do
    if curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1 || fail "Ollama no responde en $OLLAMA_URL. Revisa $LOG_FILE."

log "Descargando/verificando el modelo $MODEL..."
ollama pull "$MODEL"

log "Ejecutando prueba HTTP nativa..."
HTTP_RESPONSE=$(curl -fsS -X POST "$OLLAMA_URL/api/generate" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"Eres el asistente del núcleo del sistema AnSysWarden. Responde en una sola frase corta cuál es tu misión principal.\",\"stream\":false}")

printf '%s\n' "$HTTP_RESPONSE"

command -v node >/dev/null 2>&1 || fail "Node.js no está instalado. Instálalo en Termux antes de la prueba TypeScript."
command -v npx >/dev/null 2>&1 || fail "npx no está disponible. Instala Node.js/npm antes de continuar."

cat > "$TEST_TS" <<'EOF'
fetch('http://127.0.0.1:11434/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gemma2:2b',
    prompt: 'Clasifica esta ruta: /node_modules/.cache. Responde solo JUNK_CACHE o USER_DATA.',
    stream: false
  })
})
  .then(async (res) => {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  })
  .then((data) => {
    const answer = String(data.response ?? '').trim();
    console.log('\n[AnSysWarden] Respuesta de Gemma:', answer);

    if (!['JUNK_CACHE', 'USER_DATA'].includes(answer)) {
      console.warn('[AnSysWarden][WARN] La respuesta no coincide exactamente con las etiquetas esperadas.');
      process.exitCode = 2;
    }
  })
  .catch((err) => {
    console.error('[AnSysWarden][ERROR]', err);
    process.exit(1);
  });
EOF

log "Ejecutando prueba TypeScript..."
npx --yes tsx "$TEST_TS"

log "Pruebas terminadas. Si no hubo errores, Ollama y Gemma 2 2B responden localmente."
