#!/data/data/com.termux/files/usr/bin/bash

# ============================================================
# AnSysWarden - Entorno de desarrollo S25 Ultra <-> PC
#
# Opción 1: VS Code nativo en Windows -> Remote-SSH -> Debian ARM64
# Opción 2: VS Code Web -> code-server en Termux
# Opción 3: Ambos
# Opción 4: SSH directo a Termux (mantenimiento)
#
# Puertos:
#   Debian / VS Code Remote-SSH : 8023
#   Termux SSH                  : 8022
#   code-server                 : 8080
# ============================================================

set -u
set -o pipefail

# ------------------------------------------------------------
# CONFIGURACIÓN
# ------------------------------------------------------------

DEBIAN_CONTAINER="ansys-debian"
DEBIAN_IMAGE="debian:bookworm"
DEBIAN_USER="ansys"
DEBIAN_SSH_PORT=8023
TERMUX_SSH_PORT=8022
CODE_SERVER_PORT=8080

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

STATE_DIR="$HOME/.ansyswarden"
LOG_DIR="$STATE_DIR/logs"
RUN_DIR="$STATE_DIR/run"
TMP_DIR="$STATE_DIR/tmp"
IP_FILE="$STATE_DIR/ip"
DEBIAN_PASSWORD_FILE="$STATE_DIR/debian_password"
CODE_SERVER_CONFIG="$HOME/.config/code-server/config.yaml"

DEBIAN_SSH_LOG="$LOG_DIR/debian-sshd.log"
TERMUX_SSH_LOG="$LOG_DIR/termux-sshd.log"
CODE_SERVER_LOG="$LOG_DIR/code-server.log"
DEBIAN_PID_FILE="$RUN_DIR/debian-sshd.pid"
TERMUX_PID_FILE="$RUN_DIR/termux-sshd.pid"
CODE_SERVER_PID_FILE="$RUN_DIR/code-server.pid"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$RUN_DIR" "$TMP_DIR"

IS_TERMUX=false
if [[ -n "${PREFIX:-}" && "$PREFIX" == *"com.termux"* ]]; then
    IS_TERMUX=true
fi

if [ "$IS_TERMUX" != true ]; then
    echo "❌ Este script está pensado para ejecutarse desde Termux en el S25 Ultra."
    exit 1
fi

# ------------------------------------------------------------
# UTILIDADES
# ------------------------------------------------------------

have() {
    command -v "$1" >/dev/null 2>&1
}

is_running_pidfile() {
    local pidfile="$1"
    [ -f "$pidfile" ] || return 1
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" 2>/dev/null
}

stop_pidfile() {
    local pidfile="$1"
    [ -f "$pidfile" ] || return 0

    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 1
        done
        kill -9 "$pid" 2>/dev/null || true
    fi

    rm -f "$pidfile"
}

random_password() {
    if have openssl; then
        openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20
    else
        tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 20
    fi
}

install_termux_package() {
    local pkg_name="$1"
    if ! dpkg -s "$pkg_name" >/dev/null 2>&1; then
        echo "[+] Instalando $pkg_name..."
        pkg install -y "$pkg_name"
    fi
}

ensure_base_dependencies() {
    echo "==================================================="
    echo " 📦 Verificando dependencias de AnSysWarden..."
    echo "==================================================="

    install_termux_package openssh
    install_termux_package python
    install_termux_package nodejs
    install_termux_package proot-distro
    install_termux_package termux-exec

    if ! have code-server; then
        echo "[+] Instalando code-server desde TUR..."
        install_termux_package tur-repo
        pkg install -y code-server
    fi
}

# ------------------------------------------------------------
# IP LOCAL
# ------------------------------------------------------------

detect_ip() {
    local ip=""

    if have python; then
        ip="$(python - <<'PY' 2>/dev/null
import socket
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    print(s.getsockname()[0])
    s.close()
except Exception:
    pass
PY
)"
    fi

    if [ -z "$ip" ] && have node; then
        ip="$(node -e '
const dgram = require("dgram");
const s = dgram.createSocket("udp4");
s.on("error", () => process.exit(1));
s.connect(80, "8.8.8.8", () => {
  console.log(s.address().address);
  s.close();
});
' 2>/dev/null || true)"
    fi

    printf '%s' "$ip"
}

valid_ipv4() {
    local ip="$1"
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    local IFS='.'
    read -r a b c d <<< "$ip"
    for n in "$a" "$b" "$c" "$d"; do
        (( n >= 0 && n <= 255 )) || return 1
    done
}

get_ip() {
    if [[ "${1:-}" == "-r" || "${1:-}" == "--reset-ip" ]]; then
        rm -f "$IP_FILE"
    fi

    IP_LOCAL="$(detect_ip)"

    if ! valid_ipv4 "$IP_LOCAL" 2>/dev/null; then
        IP_LOCAL=""
    fi

    if [ -z "$IP_LOCAL" ] && [ -f "$IP_FILE" ]; then
        local saved
        saved="$(cat "$IP_FILE" 2>/dev/null || true)"
        if valid_ipv4 "$saved"; then
            IP_LOCAL="$saved"
            echo "⚠️ No se pudo detectar la IP actual. Usando IP guardada: $IP_LOCAL"
        fi
    fi

    while [ -z "$IP_LOCAL" ]; do
        echo "⚠️ Android ha bloqueado la detección automática de red."
        read -r -p "Introduce tu IP local (ej. 192.168.1.59): " IP_LOCAL
        if ! valid_ipv4 "$IP_LOCAL"; then
            echo "❌ IP no válida."
            IP_LOCAL=""
        fi
    done

    printf '%s\n' "$IP_LOCAL" > "$IP_FILE"
}

# ------------------------------------------------------------
# DEBIAN / PROOT-DISTRO
# ------------------------------------------------------------

container_installed() {
    proot-distro list -q 2>/dev/null | grep -Fxq "$DEBIAN_CONTAINER"
}

ensure_debian_container() {
    if container_installed; then
        return 0
    fi

    echo
    echo "[+] Instalando Debian ARM64 para VS Code Remote-SSH..."
    echo "    Contenedor: $DEBIAN_CONTAINER"
    echo "    Imagen:     $DEBIAN_IMAGE"

    proot-distro install "$DEBIAN_IMAGE" \
        --architecture aarch64 \
        --name "$DEBIAN_CONTAINER"
}

ensure_debian_password() {
    if [ ! -s "$DEBIAN_PASSWORD_FILE" ]; then
        random_password > "$DEBIAN_PASSWORD_FILE"
        chmod 600 "$DEBIAN_PASSWORD_FILE"
    fi
}

sync_termux_authorized_keys_to_debian() {
    local host_keys="$HOME/.ssh/authorized_keys"

    [ -s "$host_keys" ] || return 0

    local encoded
    encoded="$(base64 < "$host_keys" | tr -d '\n')"

    proot-distro login "$DEBIAN_CONTAINER" -- bash -lc "
        set -e
        install -d -m 700 -o '$DEBIAN_USER' -g '$DEBIAN_USER' '/home/$DEBIAN_USER/.ssh'
        printf '%s' '$encoded' | base64 -d > '/home/$DEBIAN_USER/.ssh/authorized_keys'
        chown '$DEBIAN_USER:$DEBIAN_USER' '/home/$DEBIAN_USER/.ssh/authorized_keys'
        chmod 600 '/home/$DEBIAN_USER/.ssh/authorized_keys'
    " >/dev/null
}

prepare_debian() {
    ensure_debian_container
    ensure_debian_password

    local debian_password
    debian_password="$(cat "$DEBIAN_PASSWORD_FILE")"

    echo
    echo "[+] Preparando Debian para VS Code Remote-SSH..."

    proot-distro login "$DEBIAN_CONTAINER" -- bash -s -- "$DEBIAN_USER" "$debian_password" <<'DEBIAN_SETUP'
set -e

DEV_USER="$1"
DEV_PASSWORD="$2"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y \
    openssh-server \
    bash \
    curl \
    wget \
    tar \
    gzip \
    ca-certificates \
    git \
    procps \
    libstdc++6 \
    passwd

if ! id "$DEV_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$DEV_USER"
fi

printf '%s:%s\n' "$DEV_USER" "$DEV_PASSWORD" | chpasswd

mkdir -p /run/sshd
mkdir -p /workspace/AnSysWarden
mkdir -p "/home/$DEV_USER/.ssh"
chmod 700 "/home/$DEV_USER/.ssh"
chown -R "$DEV_USER:$DEV_USER" "/home/$DEV_USER/.ssh"

ssh-keygen -A >/dev/null 2>&1

cat > /etc/ssh/sshd_config.d/99-ansyswarden.conf <<'SSHD_CONFIG'
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin no
KbdInteractiveAuthentication no
UsePAM no
PrintMotd no
TCPKeepAlive yes
ClientAliveInterval 60
ClientAliveCountMax 3
SSHD_CONFIG

/usr/sbin/sshd -t
DEBIAN_SETUP

    sync_termux_authorized_keys_to_debian
}

start_debian_ssh() {
    prepare_debian

    if is_running_pidfile "$DEBIAN_PID_FILE"; then
        echo "ℹ️ Debian SSH ya está ejecutándose."
        return 0
    fi

    echo
    echo "[+] Iniciando Debian ARM64 + SSH en puerto $DEBIAN_SSH_PORT..."

    : > "$DEBIAN_SSH_LOG"

    (
        exec proot-distro login "$DEBIAN_CONTAINER" \
            --bind "$PROJECT_DIR:/workspace/AnSysWarden" \
            -- bash -lc "
                mkdir -p /run/sshd /workspace/AnSysWarden
                exec /usr/sbin/sshd -D -e \
                    -p '$DEBIAN_SSH_PORT' \
                    -o ListenAddress=0.0.0.0 \
                    -o PasswordAuthentication=yes \
                    -o PubkeyAuthentication=yes \
                    -o PermitRootLogin=no \
                    -o KbdInteractiveAuthentication=no \
                    -o UsePAM=no \
                    -o AllowUsers='$DEBIAN_USER'
            "
    ) >> "$DEBIAN_SSH_LOG" 2>&1 &

    local pid=$!
    printf '%s\n' "$pid" > "$DEBIAN_PID_FILE"

    sleep 2

    if ! kill -0 "$pid" 2>/dev/null; then
        echo "❌ Debian SSH no ha podido arrancar."
        echo "---------------------------------------------------"
        tail -n 30 "$DEBIAN_SSH_LOG" 2>/dev/null || true
        echo "---------------------------------------------------"
        rm -f "$DEBIAN_PID_FILE"
        return 1
    fi

    echo "✅ Debian SSH activo."
}

# ------------------------------------------------------------
# SSH DIRECTO A TERMUX
# ------------------------------------------------------------

start_termux_ssh() {
    if is_running_pidfile "$TERMUX_PID_FILE"; then
        echo "ℹ️ SSH de Termux ya está ejecutándose."
        return 0
    fi

    # Si hay un sshd previo fuera de este script, no lo duplicamos.
    if pgrep -x sshd >/dev/null 2>&1; then
        echo "ℹ️ Ya existe un sshd de Termux en ejecución."
        return 0
    fi

    echo
    echo "[+] Iniciando SSH directo a Termux en puerto $TERMUX_SSH_PORT..."

    : > "$TERMUX_SSH_LOG"
    sshd -D -e -p "$TERMUX_SSH_PORT" >> "$TERMUX_SSH_LOG" 2>&1 &
    local pid=$!
    printf '%s\n' "$pid" > "$TERMUX_PID_FILE"

    sleep 1

    if ! kill -0 "$pid" 2>/dev/null; then
        echo "❌ SSH de Termux no ha arrancado."
        tail -n 20 "$TERMUX_SSH_LOG" 2>/dev/null || true
        rm -f "$TERMUX_PID_FILE"
        return 1
    fi

    echo "✅ SSH Termux activo."
}

# ------------------------------------------------------------
# CODE-SERVER EN TERMUX
# ------------------------------------------------------------

configure_code_server() {
    mkdir -p "$(dirname "$CODE_SERVER_CONFIG")"

    if [ ! -f "$CODE_SERVER_CONFIG" ]; then
        local password
        password="$(random_password)"

        cat > "$CODE_SERVER_CONFIG" <<EOF
bind-addr: 0.0.0.0:$CODE_SERVER_PORT
auth: password
password: $password
cert: false
EOF
    else
        if grep -q '^bind-addr:' "$CODE_SERVER_CONFIG"; then
            sed -i "s#^bind-addr:.*#bind-addr: 0.0.0.0:$CODE_SERVER_PORT#" "$CODE_SERVER_CONFIG"
        else
            printf 'bind-addr: 0.0.0.0:%s\n' "$CODE_SERVER_PORT" >> "$CODE_SERVER_CONFIG"
        fi

        if grep -q '^auth: none' "$CODE_SERVER_CONFIG"; then
            sed -i 's/^auth: none/auth: password/' "$CODE_SERVER_CONFIG"
        fi

        if ! grep -q '^password:' "$CODE_SERVER_CONFIG"; then
            printf 'password: %s\n' "$(random_password)" >> "$CODE_SERVER_CONFIG"
        fi
    fi
}

prepare_termux_exec_env() {
    export SHELL="$PREFIX/bin/bash"
    export TMPDIR="$TMP_DIR"
    mkdir -p "$TMPDIR"

    local lib=""
    if [ -f "$PREFIX/lib/libtermux-exec.so" ]; then
        lib="$PREFIX/lib/libtermux-exec.so"
    elif [ -f "$PREFIX/lib/libtermux-exec-ld-preload.so" ]; then
        lib="$PREFIX/lib/libtermux-exec-ld-preload.so"
    fi

    if [ -n "$lib" ]; then
        case ":${LD_PRELOAD:-}:" in
            *":$lib:"*) ;;
            *) export LD_PRELOAD="${LD_PRELOAD:+$LD_PRELOAD:}$lib" ;;
        esac
    fi
}

start_code_server() {
    configure_code_server
    prepare_termux_exec_env

    if is_running_pidfile "$CODE_SERVER_PID_FILE"; then
        echo "ℹ️ code-server ya está ejecutándose."
        return 0
    fi

    echo
    echo "[+] Iniciando code-server en puerto $CODE_SERVER_PORT..."

    : > "$CODE_SERVER_LOG"

    if have termux-wake-lock; then
        termux-wake-lock >/dev/null 2>&1 || true
    fi

    code-server \
        --config "$CODE_SERVER_CONFIG" \
        "$PROJECT_DIR" \
        >> "$CODE_SERVER_LOG" 2>&1 &

    local pid=$!
    printf '%s\n' "$pid" > "$CODE_SERVER_PID_FILE"

    sleep 2

    if ! kill -0 "$pid" 2>/dev/null; then
        echo "❌ code-server no ha podido arrancar."
        echo "---------------------------------------------------"
        tail -n 30 "$CODE_SERVER_LOG" 2>/dev/null || true
        echo "---------------------------------------------------"
        rm -f "$CODE_SERVER_PID_FILE"
        return 1
    fi

    echo "✅ code-server activo."
}

# ------------------------------------------------------------
# INFORMACIÓN PARA WINDOWS / VS CODE
# ------------------------------------------------------------

show_remote_ssh_info() {
    local password
    password="$(cat "$DEBIAN_PASSWORD_FILE" 2>/dev/null || true)"

    cat <<EOF

===================================================
💻 VS CODE DEL PC -> DEBIAN DEL S25
===================================================

Conexión SSH:

  ssh $DEBIAN_USER@$IP_LOCAL -p $DEBIAN_SSH_PORT

Contraseña inicial de Debian:

  $password

Carpeta del proyecto dentro de Debian:

  /workspace/AnSysWarden

Config recomendada en Windows:

  C:\\Users\\nalar\\.ssh\\config

Añade:

Host ansys-s25
    HostName $IP_LOCAL
    User $DEBIAN_USER
    Port $DEBIAN_SSH_PORT
    IdentityFile ~/.ssh/id_ed25519

Después en VS Code:

  Ctrl+Shift+P
  Remote-SSH: Connect to Host...
  ansys-s25

EOF

    if [ -s "$HOME/.ssh/authorized_keys" ]; then
        echo "🔑 Se han sincronizado las claves autorizadas de Termux con Debian."
    else
        cat <<'EOF'
🔐 Todavía no hay authorized_keys en Termux.
   Puedes entrar con la contraseña inicial de arriba y después añadir tu clave SSH.
EOF
    fi
}

show_code_server_info() {
    local password
    password="$(awk '/^password:/ {sub(/^password:[[:space:]]*/, ""); print; exit}' "$CODE_SERVER_CONFIG" 2>/dev/null || true)"

    cat <<EOF

===================================================
🌐 VS CODE WEB
===================================================
URL:
  http://$IP_LOCAL:$CODE_SERVER_PORT

Contraseña:
  $password

Log:
  $CODE_SERVER_LOG
EOF
}

show_termux_ssh_info() {
    cat <<EOF

===================================================
📱 SSH DIRECTO A TERMUX
===================================================

  ssh $(whoami)@$IP_LOCAL -p $TERMUX_SSH_PORT

Úsalo para mantenimiento de Termux, no para VS Code Remote-SSH.
EOF
}

# ------------------------------------------------------------
# CIERRE LIMPIO
# ------------------------------------------------------------

stop_services() {
    echo
    echo "[!] Deteniendo servicios iniciados por este script..."

    stop_pidfile "$CODE_SERVER_PID_FILE"
    stop_pidfile "$DEBIAN_PID_FILE"
    stop_pidfile "$TERMUX_PID_FILE"

    if have termux-wake-unlock; then
        termux-wake-unlock >/dev/null 2>&1 || true
    fi

    echo "✅ Servicios detenidos."
}

trap 'stop_services; exit 130' INT TERM

# ------------------------------------------------------------
# EJECUCIÓN
# ------------------------------------------------------------

clear
ensure_base_dependencies
get_ip "${1:-}"

clear
cat <<EOF
===================================================
 🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops)
===================================================
📡 IP actual : $IP_LOCAL
📁 Proyecto  : $PROJECT_DIR
📱 Host      : Termux / Android
===================================================

1) VS Code nativo del PC (Remote-SSH)
   └─ Debian ARM64/glibc dentro del S25
   └─ Puerto $DEBIAN_SSH_PORT

2) VS Code en navegador (code-server)
   └─ Termux
   └─ Puerto $CODE_SERVER_PORT

3) Levantar VS Code Remote-SSH + code-server

4) SSH directo a Termux
   └─ Mantenimiento
   └─ Puerto $TERMUX_SSH_PORT

5) Salir
===================================================
EOF

read -r -p "Selecciona una opción [1-5]: " OPTION

case "$OPTION" in
    1)
        start_debian_ssh && show_remote_ssh_info
        ;;
    2)
        start_code_server && show_code_server_info
        ;;
    3)
        start_debian_ssh
        start_code_server
        show_remote_ssh_info
        show_code_server_info
        ;;
    4)
        start_termux_ssh && show_termux_ssh_info
        ;;
    5)
        exit 0
        ;;
    *)
        echo "❌ Opción no válida."
        exit 1
        ;;
esac

cat <<EOF

===================================================
🟢 SERVICIOS EN EJECUCIÓN
===================================================

Proyecto Termux:
  $PROJECT_DIR

Proyecto desde Debian/VS Code:
  /workspace/AnSysWarden

Si cambias de Wi-Fi:
  ./start_dev.sh -r

EOF

read -r -p "🛑 Presiona [ENTER] para apagar los servicios iniciados por este script..."
stop_services
