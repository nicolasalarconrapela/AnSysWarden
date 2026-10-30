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
    aarch64|arm64) ok "ARM64 architecture detected: $arch" ;;
    *) warn "Detected architecture: $arch. This script is designed for S25 Ultra/ARM64." ;;
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

  info "Installing base dependencies: ${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates jq
  elif command -v pkg >/dev/null 2>&1; then
    pkg update -y
    pkg install -y curl jq
  else
    die "Missing dependencies (${missing[*]}) and neither apt-get nor pkg is available."
  fi
}

install_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama is already installed: $(ollama --version 2>/dev/null || echo 'version unavailable')"
    return
  fi

  info "Ollama is not installed. Attempting installation for the current environment..."

  # In Debian/proot we use the requested official Linux installer.
  if command -v apt-get >/dev/null 2>&1 && [[ -f /etc/debian_version ]]; then
    if curl -fsSL https://ollama.com/install.sh | sh; then
      hash -r
    else
      die "The official Ollama installer failed inside Debian/Termux. Try native Termux Ollama or an Android ARM64-specific build."
    fi
  elif command -v pkg >/dev/null 2>&1; then
    # Native Termux provides its own package, avoiding glibc binaries in Android userland.
    pkg update -y
    pkg install -y ollama || die "Could not install the Termux ollama package. Check that your Termux version and repositories are current."
  else
    die "Unrecognized environment. Install Ollama manually and run this script again."
  fi

  command -v ollama >/dev/null 2>&1 || die "Installation finished, but 'ollama' is not available in PATH."
  ok "Ollama installed successfully."
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
    ok "Ollama server is already active at $OLLAMA_HOST_URL"
    return
  fi

  info "Starting Ollama server in the background..."
  nohup ollama serve >"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > .ollama.pid

  if ! wait_for_ollama; then
    warn "Last lines from $LOG_FILE:"
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    die "Ollama did not respond at $OLLAMA_HOST_URL."
  fi

  ok "Ollama server ready (PID $pid). Log: $LOG_FILE"
}

pull_model() {
  info "Downloading/verifying model $MODEL..."
  ollama pull "$MODEL"
  ok "Model $MODEL is available."
}

native_test() {
  info "Test 1/2: native inference through HTTP API"
  local payload response text
  payload="$(jq -n --arg model "$MODEL" '{model:$model,prompt:"You are the assistant at the core of AnSysWarden. In one short sentence, state your primary mission.",stream:false}')"
  response="$(curl -fsS -H 'Content-Type: application/json' -d "$payload" "$OLLAMA_HOST_URL/api/generate")"
  text="$(jq -r '.response // empty' <<<"$response")"

  [[ -n "$text" ]] || die "Ollama responded but returned no text: $response"
  printf '\nGemma > %s\n' "$text"
  ok "Native inference completed."
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then
    return
  fi

  info "Node.js/npx are unavailable; installing them for the TypeScript test..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  elif command -v pkg >/dev/null 2>&1; then
    pkg install -y nodejs
  else
    die "Cannot install Node.js automatically."
  fi
}

typescript_test() {
  info "Test 2/2: Node.js/TypeScript integration"
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
      prompt: 'Classify this path: /node_modules/.cache. Reply EXCLUSIVELY with JUNK_CACHE or USER_DATA.',
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { response?: string };
  const answer = (data.response ?? '').trim();
  console.log(`\n[AnSysWarden] Gemma response: ${answer}`);

  if (!['JUNK_CACHE', 'USER_DATA'].includes(answer)) {
    console.warn('[AnSysWarden] WARNING: response did not exactly follow the expected contract.');
    process.exitCode = 2;
  } else if (answer !== 'JUNK_CACHE') {
    console.warn('[AnSysWarden] WARNING: format is valid, but /node_modules/.cache should be JUNK_CACHE in this test.');
    process.exitCode = 3;
  }
}

main().catch((error: unknown) => {
  console.error('[AnSysWarden] TypeScript test error:', error);
  process.exitCode = 1;
});
TS

  OLLAMA_HOST_URL="$OLLAMA_HOST_URL" ANSYSWARDEN_MODEL="$MODEL" npx --yes tsx "$TS_FILE"
  ok "TypeScript integration completed."
}

main() {
  printf '\n============================================================\n'
  printf ' AnSysWarden · Mobile AI brain bootstrap\n'
  printf ' Model: %s\n' "$MODEL"
  printf ' API:   %s\n' "$OLLAMA_HOST_URL"
  printf '============================================================\n'

  ensure_arm64
  install_base_dependencies
  install_ollama
  start_ollama
  pull_model
  native_test
  typescript_test

  printf '\n============================================================\n'
  ok "S25 Ultra is ready to use Ollama as AnSysWarden's local AI backend."
  printf 'Server: %s\n' "$OLLAMA_HOST_URL"
  printf 'Model:  %s\n' "$MODEL"
  printf 'Log:    %s\n' "$LOG_FILE"
  printf '============================================================\n\n'
}

main "$@"
