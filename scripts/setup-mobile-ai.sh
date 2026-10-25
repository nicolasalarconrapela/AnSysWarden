#!/usr/bin/env bash
set -Eeuo pipefail

MODEL="${ANSYSWARDEN_MODEL:-gemma2:2b}"
OLLAMA_HOST_URL="${OLLAMA_HOST_URL:-http://127.0.0.1:11434}"
LOG_FILE="${OLLAMA_LOG_FILE:-ollama.log}"
TS_FILE="${TMPDIR:-/tmp}/ansyswarden-test-ai.ts"

info() { printf '\n\033[1;34m[AnSysWarden]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  rm -f "$TS_FILE"
}
trap cleanup EXIT

ensure_arm64() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) ok "Arquitectura ARM64 detectada: $arch" ;;
    *) warn "Arquitectura detectada: $arch. Este script está pensado para el S25 Ultra/ARM64." ;;
  esac
}

install_base_dependencies() {
  local missing=()
  for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done

  if ((${#missing[@]} == 0)); then
    return
  fi

  info "Instalando dependencias base: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates jq
  elif command -v pkg >/dev/null 2>&1; then
    pkg update -y
    pkg install -y curl jq
  else
    die "Faltan dependencias (${missing[*]}) y no encuentro apt-get ni pkg."
  fi
}

install_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama ya está instalado: $(ollama --version 2>/dev/null || echo 'versión no disponible')"
    return
  fi

  info "Ollama no está instalado. Intentando instalación para el entorno actual..."

  # En Debian/proot usamos el instalador Linux oficial solicitado.
  if command -v apt-get >/dev/null 2>&1 && [[ -f /etc/debian_version ]]; then
    if curl -fsSL https://ollama.com/install.sh | sh; then
      hash -r
    else
      die "Falló el instalador oficial de Ollama dentro de Debian/Termux. Prueba Ollama desde Termux nativo o una build específica para Android ARM64."
    fi
  elif command -v pkg >/dev/null 2>&1; then
    # Termux nativo dispone de paquete propio; evita mezclar binarios glibc con el userland Android.
    pkg update -y
    pkg install -y ollama || die "No se pudo instalar el paquete ollama de Termux. Comprueba que usas una versión de Termux compatible y repositorios actualizados."
  else
    die "Entorno no reconocido. Instala Ollama manualmente y vuelve a ejecutar este script."
  fi

  command -v ollama >/dev/null 2>&1 || die "La instalación terminó, pero 'ollama' no está disponible en PATH."
  ok "Ollama instalado correctamente."
}

wait_for_ollama() {
  local attempts=30
  for ((i=1; i<=attempts; i++)); do
    if curl -fsS "$OLLAMA_HOST_URL/api/tags" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_ollama() {
  if curl -fsS "$OLLAMA_HOST_URL/api/tags" >/dev/null 2>&1; then
    ok "Servidor Ollama ya activo en $OLLAMA_HOST_URL"
    return
  fi

  info "Iniciando servidor Ollama en segundo plano..."
  nohup ollama serve >"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > .ollama.pid

  if ! wait_for_ollama; then
    warn "Últimas líneas de $LOG_FILE:"
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    die "Ollama no respondió en $OLLAMA_HOST_URL."
  fi

  ok "Servidor Ollama listo (PID $pid). Log: $LOG_FILE"
}

pull_model() {
  info "Descargando/verificando modelo $MODEL..."
  ollama pull "$MODEL"
  ok "Modelo $MODEL disponible."
}

native_test() {
  info "Prueba 1/2: inferencia nativa mediante API HTTP"
  local payload response text
  payload="$(jq -n --arg model "$MODEL" '{model:$model,prompt:"Eres el asistente del núcleo del sistema AnSysWarden. Responde en una sola frase corta cuál es tu misión principal.",stream:false}')"
  response="$(curl -fsS -H 'Content-Type: application/json' -d "$payload" "$OLLAMA_HOST_URL/api/generate")"
  text="$(jq -r '.response // empty' <<<"$response")"

  [[ -n "$text" ]] || die "Ollama respondió, pero no devolvió texto: $response"
  printf '\nGemma > %s\n' "$text"
  ok "Inferencia nativa completada."
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
    return
  fi

  info "Node.js/npx no están disponibles; instalándolos para la prueba TypeScript..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  elif command -v pkg >/dev/null 2>&1; then
    pkg install -y nodejs
  else
    die "No puedo instalar Node.js automáticamente."
  fi
}

typescript_test() {
  info "Prueba 2/2: integración Node.js/TypeScript"
  ensure_node

  cat > "$TS_FILE" <<'TS'
const host = process.env.OLLAMA_HOST_URL ?? 'http://127.0.0.1:11434';
const model = process.env.ANSYSWARDEN_MODEL ?? 'gemma2:2b';

async function main(): Promise<void> {
  const response = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: 'Clasifica esta ruta: /node_modules/.cache. Responde EXCLUSIVAMENTE con JUNK_CACHE o USER_DATA.',
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { response?: string };
  const answer = (data.response ?? '').trim();
  console.log(`\n[AnSysWarden] Respuesta de Gemma: ${answer}`);

  if (!['JUNK_CACHE', 'USER_DATA'].includes(answer)) {
    console.warn('[AnSysWarden] AVISO: la respuesta no respetó exactamente el contrato esperado.');
    process.exitCode = 2;
  } else if (answer !== 'JUNK_CACHE') {
    console.warn('[AnSysWarden] AVISO: el formato es válido, pero /node_modules/.cache debería clasificarse como JUNK_CACHE en esta prueba.');
    process.exitCode = 3;
  }
}

main().catch((error: unknown) => {
  console.error('[AnSysWarden] Error en la prueba TypeScript:', error);
  process.exitCode = 1;
});
TS

  OLLAMA_HOST_URL="$OLLAMA_HOST_URL" ANSYSWARDEN_MODEL="$MODEL" npx --yes tsx "$TS_FILE"
  ok "Integración TypeScript completada."
}

main() {
  printf '\n============================================================\n'
  printf ' AnSysWarden · Bootstrap del cerebro IA móvil\n'
  printf ' Modelo: %s\n' "$MODEL"
  printf ' API:    %s\n' "$OLLAMA_HOST_URL"
  printf '============================================================\n'

  ensure_arm64
  install_base_dependencies
  install_ollama
  start_ollama
  pull_model
  native_test
  typescript_test

  printf '\n============================================================\n'
  ok "S25 Ultra listo para usar Ollama como backend local de AnSysWarden."
  printf 'Servidor: %s\n' "$OLLAMA_HOST_URL"
  printf 'Modelo:   %s\n' "$MODEL"
  printf 'Log:      %s\n' "$LOG_FILE"
  printf '============================================================\n\n'
}

main "$@"
