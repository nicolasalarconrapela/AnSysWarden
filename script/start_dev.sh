#!/usr/bin/env bash

# ============================================================
# AnSysWarden - entorno de desarrollo S25 Ultra <-> PC
# ============================================================
#
# Termux / Android:
#   1) SSH de terminal (puerto 8022)
#   2) VS Code Web con code-server (puerto 8080)
#   3) Ambos
#
# Nota:
#   VS Code Remote-SSH directo contra Termux NO se anuncia como
#   soportado: el VS Code Server Linux puede fallar en Android.
#
# Uso:
#   ./start_dev.sh
#   ./start_dev.sh -r
#   ./start_dev.sh --reset-ip
# ============================================================

set -uo pipefail

SSH_PORT_TERMUX=8022
SSH_PORT_LINUX=22
CODE_SERVER_PORT=8080

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"

STATE_DIR="$HOME/.ansyswarden"
LOG_DIR="$STATE_DIR/logs"
RUN_DIR="$STATE_DIR/run"
TMP_DIR="$STATE_DIR/tmp"
IP_CONFIG_FILE="$STATE_DIR/ip"
CODE_SERVER_CONFIG="$HOME/.config/code-server/config.yaml"
CODE_SERVER_LOG="$LOG_DIR/code-server.log"
CODE_SERVER_PID_FILE="$RUN_DIR/code-server.pid"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$RUN_DIR" "$TMP_DIR"

IS_TERMUX=false
if [[ -n "${TERMUX_VERSION:-}" ]] || [[ "${PREFIX:-}" == *"com.termux"* ]]; then
    IS_TERMUX=true
fi

SSH_STARTED_BY_SCRIPT=false
CODE_SERVER_STARTED_BY_SCRIPT=false
CLEANED_UP=false

line() { printf '%s\n' "==================================================="; }
info() { printf 'ℹ️  %s\n' "$*"; }
ok() { printf '✅ %s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; }

APT_UPDATED=false

apt_install() {
    if [ "$APT_UPDATED" = false ]; then
        apt update || return 1
        APT_UPDATED=true
    fi
    apt install -y "$@"
}

ensure_command() {
    local command_name="$1"
    shift

    if command -v "$command_name" >/dev/null 2>&1; then
        return 0
    fi

    "$@"
}

install_dependencies() {
    clear 2>/dev/null || true
    line
    echo " 📦 Verificando dependencias de AnSysWarden..."
    line

    if [ "$IS_TERMUX" = true ]; then
        info "Entorno detectado: Android / Termux"

        if ! command -v pkg >/dev/null 2>&1; then
            fail "Se detectó Termux pero no existe el comando pkg."
            return 1
        fi

        ensure_command sshd pkg install -y openssh || return 1
        ensure_command python pkg install -y python || return 1
        ensure_command node pkg install -y nodejs || return 1

        if [ ! -f "${PREFIX:-}/lib/libtermux-exec.so" ]; then
            info "Instalando/reparando termux-exec..."
            pkg install -y termux-exec || return 1
        fi

        if ! command -v code-server >/dev/null 2>&1; then
            info "Instalando repositorio TUR y code-server..."
            pkg install -y tur-repo || return 1
            pkg install -y code-server || return 1
        fi
    else
        info "Entorno detectado: Linux"

        ensure_command sshd apt_install openssh-server || return 1

        if ! command -v python >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
            apt_install python3 || return 1
        fi

        ensure_command node apt_install nodejs || return 1

        if ! command -v code-server >/dev/null 2>&1; then
            ensure_command curl apt_install curl || return 1
            info "Instalando code-server..."
            curl -fsSL https://code-server.dev/install.sh | sh || return 1
        fi
    fi

    ok "Dependencias preparadas."
}

is_valid_ipv4() {
    local ip="${1:-}"
    local a b c d extra

    IFS=. read -r a b c d extra <<< "$ip"
    [ -z "${extra:-}" ] || return 1

    for octet in "$a" "$b" "$c" "$d"; do
        [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
        (( 10#$octet >= 0 && 10#$octet <= 255 )) || return 1
    done
}

detect_ip_python() {
    local py=""

    if command -v python >/dev/null 2>&1; then
        py="$(command -v python)"
    elif command -v python3 >/dev/null 2>&1; then
        py="$(command -v python3)"
    else
        return 1
    fi

    "$py" - <<'PY_IP' 2>/dev/null
import socket

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(("1.1.1.1", 80))
    print(s.getsockname()[0])
finally:
    s.close()
PY_IP
}

detect_ip() {
    local ip=""

    ip="$(detect_ip_python 2>/dev/null || true)"
    if is_valid_ipv4 "$ip" && [[ "$ip" != 127.* ]]; then
        printf '%s\n' "$ip"
        return 0
    fi

    if command -v hostname >/dev/null 2>&1; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
        if is_valid_ipv4 "$ip" && [[ "$ip" != 127.* ]]; then
            printf '%s\n' "$ip"
            return 0
        fi
    fi

    return 1
}

get_ip() {
    local reset_ip=false

    case "${1:-}" in
        -r|--reset-ip)
            reset_ip=true
            rm -f "$IP_CONFIG_FILE"
            ;;
    esac

    IP_LOCAL="$(detect_ip 2>/dev/null || true)"

    if is_valid_ipv4 "$IP_LOCAL"; then
        printf '%s\n' "$IP_LOCAL" > "$IP_CONFIG_FILE"
        return 0
    fi

    IP_LOCAL=""

    if [ "$reset_ip" = false ] && [ -f "$IP_CONFIG_FILE" ]; then
        local cached_ip
        cached_ip="$(tr -d '[:space:]' < "$IP_CONFIG_FILE")"
        if is_valid_ipv4 "$cached_ip"; then
            IP_LOCAL="$cached_ip"
            warn "No se pudo detectar la IP actual; usando la guardada: $IP_LOCAL"
            return 0
        fi
    fi

    warn "No se pudo detectar la IP automáticamente."

    while true; do
        read -r -p "Introduce tu IP local (ej. 192.168.1.59): " IP_LOCAL
        IP_LOCAL="$(printf '%s' "$IP_LOCAL" | tr -d '[:space:]')"

        if is_valid_ipv4 "$IP_LOCAL"; then
            printf '%s\n' "$IP_LOCAL" > "$IP_CONFIG_FILE"
            return 0
        fi

        warn "La IP '$IP_LOCAL' no es una IPv4 válida."
    done
}

generate_password() {
    local py=""

    if command -v python >/dev/null 2>&1; then
        py="$(command -v python)"
    elif command -v python3 >/dev/null 2>&1; then
        py="$(command -v python3)"
    fi

    if [ -n "$py" ]; then
        "$py" - <<'PY_PASS'
import secrets
import string
alphabet = string.ascii_letters + string.digits
print(''.join(secrets.choice(alphabet) for _ in range(24)))
PY_PASS
    else
        tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24
        printf '\n'
    fi
}

set_yaml_key() {
    local file="$1"
    local key="$2"
    local value="$3"

    if grep -Eq "^[[:space:]]*${key}:" "$file" 2>/dev/null; then
        sed -i -E "s|^[[:space:]]*${key}:.*|${key}: ${value}|" "$file"
    else
        printf '%s: %s\n' "$key" "$value" >> "$file"
    fi
}

configure_code_server() {
    mkdir -p "$(dirname "$CODE_SERVER_CONFIG")"

    if [ ! -f "$CODE_SERVER_CONFIG" ]; then
        local new_password
        new_password="$(generate_password)"

        cat > "$CODE_SERVER_CONFIG" <<CONFIG_EOF
bind-addr: 0.0.0.0:${CODE_SERVER_PORT}
auth: password
password: ${new_password}
cert: false
CONFIG_EOF

        chmod 600 "$CODE_SERVER_CONFIG" 2>/dev/null || true
        ok "Configuración segura de code-server creada."
        return 0
    fi

    set_yaml_key "$CODE_SERVER_CONFIG" "bind-addr" "0.0.0.0:${CODE_SERVER_PORT}"

    if grep -Eq '^[[:space:]]*auth:[[:space:]]*none[[:space:]]*$' "$CODE_SERVER_CONFIG"; then
        set_yaml_key "$CODE_SERVER_CONFIG" "auth" "password"
    elif ! grep -Eq '^[[:space:]]*auth:' "$CODE_SERVER_CONFIG"; then
        set_yaml_key "$CODE_SERVER_CONFIG" "auth" "password"
    fi

    if ! grep -Eq '^[[:space:]]*(password|hashed-password):' "$CODE_SERVER_CONFIG"; then
        set_yaml_key "$CODE_SERVER_CONFIG" "password" "$(generate_password)"
    fi

    if ! grep -Eq '^[[:space:]]*cert:' "$CODE_SERVER_CONFIG"; then
        set_yaml_key "$CODE_SERVER_CONFIG" "cert" "false"
    fi

    chmod 600 "$CODE_SERVER_CONFIG" 2>/dev/null || true
}

prepare_termux_environment() {
    [ "$IS_TERMUX" = true ] || return 0

    export SHELL="$PREFIX/bin/bash"
    export TMPDIR="$TMP_DIR"
    export PATH="$PREFIX/bin:${PATH:-}"
    mkdir -p "$TMPDIR"

    local termux_exec_lib="$PREFIX/lib/libtermux-exec.so"

    if [ ! -f "$termux_exec_lib" ]; then
        info "Reparando termux-exec..."
        pkg install -y termux-exec || return 1
    fi

    if [ ! -f "$termux_exec_lib" ]; then
        fail "No existe $termux_exec_lib después de instalar termux-exec."
        return 1
    fi

    case ":${LD_PRELOAD:-}:" in
        *":$termux_exec_lib:"*) ;;
        "::") export LD_PRELOAD="$termux_exec_lib" ;;
        *) export LD_PRELOAD="$termux_exec_lib:${LD_PRELOAD:-}" ;;
    esac

    ok "termux-exec activo: $termux_exec_lib"
}

find_code_server_vscode_out() {
    local candidate=""

    for candidate in \
        "$PREFIX/lib/code-server/lib/vscode/out" \
        "$PREFIX/lib/code-server/out"; do
        if [ -d "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    local server_main
    server_main="$(find "$PREFIX/lib" -type f -path '*/vscode/out/server-main.js' -print -quit 2>/dev/null || true)"

    if [ -n "$server_main" ]; then
        dirname "$server_main"
        return 0
    fi

    return 1
}

patch_code_server_ld_preload() {
    [ "$IS_TERMUX" = true ] || return 0

    local vscode_out
    vscode_out="$(find_code_server_vscode_out 2>/dev/null || true)"

    if [ -z "$vscode_out" ] || [ ! -d "$vscode_out" ]; then
        warn "No se encontró el runtime interno de VS Code de code-server."
        warn "No se puede aplicar automáticamente el workaround de LD_PRELOAD."
        return 0
    fi

    local files=(
        "$vscode_out/server-main.js"
        "$vscode_out/vs/platform/agentHost/node/agentHostMain.js"
        "$vscode_out/vs/workbench/api/node/extensionHostProcess.js"
    )

    local py=""
    if command -v python >/dev/null 2>&1; then
        py="$(command -v python)"
    elif command -v python3 >/dev/null 2>&1; then
        py="$(command -v python3)"
    else
        fail "Python es necesario para aplicar el workaround de code-server."
        return 1
    fi

    local patched=0
    local found=0
    local file=""
    local stamp
    stamp="$(date +%Y%m%d-%H%M%S)"

    for file in "${files[@]}"; do
        [ -f "$file" ] || continue
        found=$((found + 1))

        if "$py" - "$file" <<'PY_CHECK'
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text(encoding="utf-8")
sys.exit(0 if re.search(r'(["\'])LD_PRELOAD\1\s*,', text) else 1)
PY_CHECK
        then
            cp -p "$file" "$file.ansyswarden.bak.$stamp" || {
                fail "No se pudo crear backup de $file"
                return 1
            }

            "$py" - "$file" <<'PY_PATCH'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
text2 = re.sub(r'(["\'])LD_PRELOAD\1\s*,\s*', '', text)
if text2 == text:
    raise SystemExit(2)
path.write_text(text2, encoding="utf-8")
PY_PATCH
            rc=$?

            if [ "$rc" -ne 0 ]; then
                fail "No se pudo aplicar el workaround a $file"
                return 1
            fi

            ok "Workaround LD_PRELOAD aplicado: $file"
            patched=$((patched + 1))
        fi
    done

    if [ "$found" -eq 0 ]; then
        warn "No se encontraron los archivos internos esperados de VS Code."
    elif [ "$patched" -eq 0 ]; then
        ok "Workaround LD_PRELOAD ya aplicado o no requerido por esta build."
    fi
}

prepare_code_server() {
    configure_code_server || return 1

    if [ "$IS_TERMUX" = true ]; then
        prepare_termux_environment || return 1
        patch_code_server_ld_preload || return 1
    fi
}

start_ssh() {
    echo
    info "Preparando SSH..."

    if pgrep -x sshd >/dev/null 2>&1; then
        ok "sshd ya estaba ejecutándose; no se reinicia ni se tocará al salir."
        SSH_STARTED_BY_SCRIPT=false
    else
        if [ "$IS_TERMUX" = true ]; then
            sshd -p "$SSH_PORT_TERMUX" || {
                fail "No se pudo iniciar sshd en el puerto $SSH_PORT_TERMUX."
                return 1
            }
            SSH_PORT="$SSH_PORT_TERMUX"
        else
            if command -v systemctl >/dev/null 2>&1; then
                systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || return 1
            else
                service ssh start 2>/dev/null || /etc/init.d/ssh start 2>/dev/null || return 1
            fi
            SSH_PORT="$SSH_PORT_LINUX"
        fi

        SSH_STARTED_BY_SCRIPT=true
        sleep 1

        if ! pgrep -x sshd >/dev/null 2>&1; then
            fail "sshd terminó después de arrancar."
            return 1
        fi

        ok "SSH iniciado."
    fi

    if [ "$IS_TERMUX" = true ]; then
        SSH_PORT="$SSH_PORT_TERMUX"
    else
        SSH_PORT="$SSH_PORT_LINUX"
    fi

    echo
    echo "Desde el PC:"
    echo "  ssh ${USER_NAME}@${IP_LOCAL} -p ${SSH_PORT}"

    if [ "$IS_TERMUX" = true ]; then
        echo
        warn "Este SSH sirve para terminal/SFTP."
        warn "VS Code Remote-SSH directo contra Termux puede fallar por incompatibilidad Android/Linux."
    fi
}

is_our_code_server_running() {
    [ -f "$CODE_SERVER_PID_FILE" ] || return 1

    local pid
    pid="$(cat "$CODE_SERVER_PID_FILE" 2>/dev/null || true)"

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    kill -0 "$pid" 2>/dev/null || return 1
}

start_code_server() {
    echo
    info "Preparando code-server..."

    prepare_code_server || return 1

    if is_our_code_server_running; then
        ok "La instancia de code-server de AnSysWarden ya está ejecutándose."
        CODE_SERVER_STARTED_BY_SCRIPT=false
    else
        rm -f "$CODE_SERVER_PID_FILE"

        if pgrep -f '[c]ode-server' >/dev/null 2>&1; then
            warn "Ya existe otro proceso code-server."
            warn "No se cerrará ni modificará; el puerto $CODE_SERVER_PORT podría estar ocupado."
        fi

        : > "$CODE_SERVER_LOG"

        (
            export TMPDIR="$TMP_DIR"
            if [ "$IS_TERMUX" = true ]; then
                export SHELL="$PREFIX/bin/bash"
            fi

            exec code-server \
                --config "$CODE_SERVER_CONFIG" \
                "$PROJECT_DIR"
        ) >> "$CODE_SERVER_LOG" 2>&1 &

        local pid=$!
        printf '%s\n' "$pid" > "$CODE_SERVER_PID_FILE"
        CODE_SERVER_STARTED_BY_SCRIPT=true

        sleep 3

        if ! kill -0 "$pid" 2>/dev/null; then
            fail "code-server se cerró durante el arranque."
            echo
            echo "Últimas líneas del log:"
            echo "---------------------------------------------------"
            tail -n 40 "$CODE_SERVER_LOG" 2>/dev/null || true
            echo "---------------------------------------------------"
            rm -f "$CODE_SERVER_PID_FILE"
            CODE_SERVER_STARTED_BY_SCRIPT=false
            return 1
        fi

        ok "code-server iniciado (PID $pid)."
    fi

    local password=""
    local hashed=false

    if grep -Eq '^[[:space:]]*hashed-password:' "$CODE_SERVER_CONFIG" 2>/dev/null; then
        hashed=true
    else
        password="$(sed -n -E 's/^[[:space:]]*password:[[:space:]]*(.*)$/\1/p' "$CODE_SERVER_CONFIG" | head -n 1)"
    fi

    echo
    echo "VS Code Web:"
    echo "  http://${IP_LOCAL}:${CODE_SERVER_PORT}"

    if [ "$hashed" = true ]; then
        echo "  Contraseña: usa la que ya configuraste (está almacenada como hash)."
    elif [ -n "$password" ]; then
        echo "  Contraseña: $password"
    fi

    echo "  Log: $CODE_SERVER_LOG"
    echo
    echo "Prueba crítica dentro del navegador: Terminal -> New Terminal"
}

cleanup() {
    [ "$CLEANED_UP" = false ] || return 0
    CLEANED_UP=true

    echo
    info "Deteniendo solo los servicios iniciados por este script..."

    if [ "$CODE_SERVER_STARTED_BY_SCRIPT" = true ] && [ -f "$CODE_SERVER_PID_FILE" ]; then
        local pid
        pid="$(cat "$CODE_SERVER_PID_FILE" 2>/dev/null || true)"

        if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true

            for _ in 1 2 3 4 5; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 0.2
            done

            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi

        rm -f "$CODE_SERVER_PID_FILE"
    fi

    if [ "$SSH_STARTED_BY_SCRIPT" = true ]; then
        pkill -x sshd 2>/dev/null || true
    fi

    ok "Entorno cerrado."
}

on_signal() {
    cleanup
    exit 130
}

trap on_signal INT TERM

main() {
    install_dependencies || {
        fail "No se pudieron preparar todas las dependencias."
        exit 1
    }

    get_ip "${1:-}" || exit 1
    USER_NAME="$(whoami)"

    clear 2>/dev/null || true
    line
    echo " 🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops)"
    line
    echo "📡 IP actual : $IP_LOCAL"
    echo "👤 Usuario   : $USER_NAME"
    echo "📁 Proyecto  : $PROJECT_DIR"

    if [ "$IS_TERMUX" = true ]; then
        echo "📱 Plataforma: Android / Termux"
    else
        echo "🐧 Plataforma: Linux"
    fi

    echo "💡 Si cambias de Wi-Fi: ./start_dev.sh -r"
    line
    echo "Elige cómo quieres abrir el entorno:"
    echo

    if [ "$IS_TERMUX" = true ]; then
        echo "1) SSH al S25 Ultra"
        echo "   └─ Terminal/SFTP (no VS Code Remote-SSH directo)"
    else
        echo "1) SSH para VS Code Remote-SSH"
    fi

    echo "2) VS Code en navegador (code-server)"
    echo "3) Levantar SSH + code-server"
    line

    local option
    read -r -p "Selecciona una opción [1-3]: " option

    case "$option" in
        1)
            start_ssh || { cleanup; exit 1; }
            ;;
        2)
            start_code_server || { cleanup; exit 1; }
            ;;
        3)
            start_ssh || { cleanup; exit 1; }
            start_code_server || { cleanup; exit 1; }
            ;;
        *)
            fail "Opción no válida: $option"
            exit 2
            ;;
    esac

    echo
    line
    echo "🟢 SERVICIOS EN EJECUCIÓN"
    line
    echo "Proyecto: $PROJECT_DIR"
    echo

    read -r -p "🛑 Presiona [ENTER] para apagar los servicios iniciados por este script..."
    cleanup
}

main "$@"
