#!/data/data/com.termux/files/usr/bin/bash

set -u

# ============================================================
# AnSysWarden - DEVELOPMENT environment on S25 Ultra / Termux
#
# DEVELOPMENT only:
#   1) VS Code Windows + SSH FS       (recommended)
#   2) VS Code Web / code-server      (fallback)
#   3) Direct SSH to Termux
#   4) VS Code Remote-SSH via Debian  (experimental)
#   5) SSH + code-server
#   6) DEV environment status
#   7) Stop DEV services started by this script
#   0) Exit
#
# Does NOT manage Ollama, Gemma, models, or inference.
# ============================================================

SSH_PORT=8022
CODE_SERVER_PORT=8080
DEBIAN_SSH_PORT=8023

STATE_DIR="$HOME/.ansyswarden-dev"
LOG_DIR="$STATE_DIR/logs"
PID_DIR="$STATE_DIR/pids"
IP_FILE="$STATE_DIR/ip"

mkdir -p "$LOG_DIR" "$PID_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

USER_NAME="$(whoami)"
IP_LOCAL=""

DEBIAN_DISTRO="debian"
DEBIAN_PROJECT="/workspace/AnSysWarden"
DEBIAN_PASSWORD_FILE="$STATE_DIR/debian-root-password"

have() {
    command -v "$1" >/dev/null 2>&1
}

is_termux() {
    [[ -n "${PREFIX:-}" && "$PREFIX" == *"/com.termux/"* ]]
}

pause_screen() {
    echo
    read -r -p "Press [ENTER] to return to the menu..." _
}

safe_pid_alive() {
    local pid="${1:-}"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
    local file="$1"
    [[ -f "$file" ]] && cat "$file" 2>/dev/null || true
}

random_password() {
    if have openssl; then
        openssl rand -hex 12
    else
        tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24
        echo
    fi
}

detect_ip() {
    local ip=""

    if have python; then
        ip="$(
            python - <<'PY'
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
    elif have python3; then
        ip="$(
            python3 - <<'PY'
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

    if [[ -z "$ip" ]] && have ip; then
        ip="$(
            ip -4 route get 1.1.1.1 2>/dev/null |
            awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
        )"
    fi

    printf '%s' "$ip"
}

load_ip() {
    local reset="${1:-}"

    if [[ "$reset" == "-r" || "$reset" == "--reset-ip" ]]; then
        rm -f "$IP_FILE"
    fi

    IP_LOCAL="$(detect_ip 2>/dev/null || true)"

    if [[ -n "$IP_LOCAL" ]]; then
        printf '%s\n' "$IP_LOCAL" > "$IP_FILE"
        return
    fi

    if [[ -f "$IP_FILE" ]]; then
        IP_LOCAL="$(cat "$IP_FILE" 2>/dev/null || true)"
    fi

    if [[ -z "$IP_LOCAL" ]]; then
        echo "⚠️ Could not detect the local IP automatically."
        read -r -p "Enter the S25 IP (e.g. 192.168.1.59): " IP_LOCAL
        printf '%s\n' "$IP_LOCAL" > "$IP_FILE"
    fi
}

port_listening() {
    local port="$1"
    if have ss; then
        ss -ltn 2>/dev/null |
            awk '{print $4}' |
            grep -Eq "[:.]${port}$"
        return $?
    fi
    return 1
}

ensure_termux_base() {
    if ! is_termux; then
        echo "❌ This script is intended for Termux on Android."
        return 1
    fi

    if ! have sshd; then
        echo "[+] Installing OpenSSH..."
        pkg install openssh -y || return 1
    fi

    if ! have python && ! have python3; then
        echo "[+] Installing Python..."
        pkg install python -y || return 1
    fi
}

start_termux_ssh() {
    ensure_termux_base || return 1

    local pid_file="$PID_DIR/termux-sshd.pid"
    local saved_pid
    saved_pid="$(read_pid "$pid_file")"

    if safe_pid_alive "$saved_pid"; then
        echo "✅ Termux SSH is already running under this script (PID $saved_pid)."
        return 0
    fi

    rm -f "$pid_file"

    if port_listening "$SSH_PORT"; then
        echo "ℹ️ A service is already listening on :$SSH_PORT."
        echo "   This script will not stop it when closing."
        return 0
    fi

    local before after new_pid
    before="$(pgrep -x sshd 2>/dev/null | tr '\n' ' ' || true)"

    echo "[+] Starting Termux SSH on :$SSH_PORT..."
    sshd -p "$SSH_PORT" || {
        echo "❌ Could not start sshd."
        return 1
    }

    sleep 1

    after="$(pgrep -x sshd 2>/dev/null || true)"
    new_pid=""

    while read -r p; do
        [[ -z "$p" ]] && continue
        if [[ " $before " != *" $p "* ]]; then
            new_pid="$p"
            break
        fi
    done <<< "$after"

    if [[ -n "$new_pid" ]]; then
        printf '%s\n' "$new_pid" > "$pid_file"
    fi

    echo "✅ Termux SSH active."
}

show_sshfs_info() {
    start_termux_ssh || return 1

    echo
    echo "============================================================"
    echo " ✅ READY FOR NATIVE VS CODE + SSH FS"
    echo "============================================================"
    echo
    echo "SSH FS configuration:"
    echo
    echo "  Name : AnSysWarden-S25"
    echo "  Host : $IP_LOCAL"
    echo "  Port : $SSH_PORT"
    echo "  User : $USER_NAME"
    echo "  Root : $PROJECT_DIR"
    echo
    echo "In VS Code on Windows:"
    echo "  Ctrl+Shift+P"
    echo "  → SSH FS: Connect as Workspace Folder"
    echo "  → AnSysWarden-S25"
    echo
    echo "Manual SSH test:"
    echo "  ssh $USER_NAME@$IP_LOCAL -p $SSH_PORT"
}

ensure_code_server() {
    if have code-server; then
        return 0
    fi

    echo "[+] Installing code-server from TUR..."
    pkg install tur-repo -y || return 1
    pkg install code-server -y || return 1
}

find_termux_exec_lib() {
    local lib=""

    if [[ -f "$PREFIX/lib/libtermux-exec.so" ]]; then
        lib="$PREFIX/lib/libtermux-exec.so"
    elif [[ -f "$PREFIX/lib/libtermux-exec-ld-preload.so" ]]; then
        lib="$PREFIX/lib/libtermux-exec-ld-preload.so"
    fi

    if [[ -z "$lib" ]]; then
        pkg install termux-exec -y >/dev/null 2>&1 || true

        if [[ -f "$PREFIX/lib/libtermux-exec.so" ]]; then
            lib="$PREFIX/lib/libtermux-exec.so"
        elif [[ -f "$PREFIX/lib/libtermux-exec-ld-preload.so" ]]; then
            lib="$PREFIX/lib/libtermux-exec-ld-preload.so"
        fi
    fi

    printf '%s' "$lib"
}

patch_code_server_for_termux() {
    local termux_exec_lib
    termux_exec_lib="$(find_termux_exec_lib)"

    export SHELL="$PREFIX/bin/bash"
    export TMPDIR="$STATE_DIR/tmp"
    mkdir -p "$TMPDIR"

    if [[ -n "$termux_exec_lib" ]]; then
        case "${LD_PRELOAD:-}" in
            *"$termux_exec_lib"*) ;;
            "") export LD_PRELOAD="$termux_exec_lib" ;;
            *) export LD_PRELOAD="$termux_exec_lib:$LD_PRELOAD" ;;
        esac
        echo "✅ termux-exec: $termux_exec_lib"
    else
        echo "⚠️ libtermux-exec was not found."
    fi

    local vscode_out="$PREFIX/lib/code-server/lib/vscode/out"

    if [[ ! -d "$vscode_out" ]]; then
        local server_main
        server_main="$(
            find "$PREFIX/lib/code-server" \
                -type f \
                -path '*/vscode/out/server-main.js' \
                2>/dev/null |
            head -n 1
        )"
        [[ -n "$server_main" ]] && vscode_out="$(dirname "$server_main")"
    fi

    [[ -d "$vscode_out" ]] || {
        echo "⚠️ Could not locate the internal VS Code runtime."
        return 0
    }

    local files=(
        "$vscode_out/server-main.js"
        "$vscode_out/vs/platform/agentHost/node/agentHostMain.js"
        "$vscode_out/vs/workbench/api/node/extensionHostProcess.js"
    )

    local f backup
    for f in "${files[@]}"; do
        [[ -f "$f" ]] || continue

        if grep -q '"LD_PRELOAD",' "$f" 2>/dev/null; then
            backup="$f.ansyswarden.bak"
            [[ -f "$backup" ]] || cp "$f" "$backup"
            sed -i 's/"LD_PRELOAD",//g' "$f"
            echo "🔧 LD_PRELOAD workaround applied: $f"
        fi
    done
}

configure_code_server() {
    local config_dir="$HOME/.config/code-server"
    local config="$config_dir/config.yaml"

    mkdir -p "$config_dir"

    if [[ ! -f "$config" ]]; then
        local password
        password="$(random_password)"

        cat > "$config" <<EOF
bind-addr: 0.0.0.0:$CODE_SERVER_PORT
auth: password
password: $password
cert: false
EOF
        chmod 600 "$config" 2>/dev/null || true
        return
    fi

    if grep -q '^bind-addr:' "$config"; then
        sed -i "s/^bind-addr:.*/bind-addr: 0.0.0.0:$CODE_SERVER_PORT/" "$config"
    else
        printf '\nbind-addr: 0.0.0.0:%s\n' "$CODE_SERVER_PORT" >> "$config"
    fi

    if grep -q '^auth:[[:space:]]*none' "$config"; then
        sed -i 's/^auth:[[:space:]]*none/auth: password/' "$config"
    fi

    if ! grep -q '^password:' "$config"; then
        printf 'password: %s\n' "$(random_password)" >> "$config"
    fi
}

start_code_server() {
    ensure_termux_base || return 1
    ensure_code_server || return 1

    local pid_file="$PID_DIR/code-server.pid"
    local pid
    pid="$(read_pid "$pid_file")"

    if safe_pid_alive "$pid"; then
        echo "✅ code-server is already running under this script (PID $pid)."
        return 0
    fi

    rm -f "$pid_file"

    if port_listening "$CODE_SERVER_PORT"; then
        echo "ℹ️ A service is already listening on :$CODE_SERVER_PORT."
        echo "   This script will not stop it when closing."
        return 0
    fi

    configure_code_server
    patch_code_server_for_termux

    local config="$HOME/.config/code-server/config.yaml"
    local log="$LOG_DIR/code-server.log"

    echo "[+] Starting code-server on :$CODE_SERVER_PORT..."

    if have setsid; then
        setsid code-server --config "$config" "$PROJECT_DIR" > "$log" 2>&1 &
    else
        nohup code-server --config "$config" "$PROJECT_DIR" > "$log" 2>&1 &
    fi

    pid=$!
    printf '%s\n' "$pid" > "$pid_file"

    sleep 3

    if ! safe_pid_alive "$pid" && ! port_listening "$CODE_SERVER_PORT"; then
        echo "❌ code-server failed to start."
        tail -n 25 "$log" 2>/dev/null || true
        rm -f "$pid_file"
        return 1
    fi

    local password
    password="$(
        awk '
            /^password:/ {
                sub(/^password:[[:space:]]*/, "")
                print
                exit
            }
        ' "$config" 2>/dev/null
    )"

    echo "✅ code-server active."
    echo "  URL : http://$IP_LOCAL:$CODE_SERVER_PORT"
    [[ -n "$password" ]] && echo "  Pass: $password"
    echo "  Log : $log"
}

ensure_proot_debian() {
    if ! have proot-distro; then
        echo "[+] Installing proot-distro..."
        pkg install proot-distro -y || return 1
    fi

    if ! proot-distro login "$DEBIAN_DISTRO" -- true >/dev/null 2>&1; then
        echo "[+] Installing Debian in PRoot..."
        proot-distro install "$DEBIAN_DISTRO" || return 1
    fi
}

prepare_debian_ssh() {
    ensure_proot_debian || return 1

    local password
    if [[ -f "$DEBIAN_PASSWORD_FILE" ]]; then
        password="$(cat "$DEBIAN_PASSWORD_FILE")"
    else
        password="$(random_password)"
        printf '%s\n' "$password" > "$DEBIAN_PASSWORD_FILE"
        chmod 600 "$DEBIAN_PASSWORD_FILE" 2>/dev/null || true
    fi

    echo "[+] Preparing SSH inside Debian..."

    proot-distro login "$DEBIAN_DISTRO" \
        --bind "$PROJECT_DIR:$DEBIAN_PROJECT" \
        -- bash -lc "
            set -e
            if ! command -v sshd >/dev/null 2>&1; then
                apt-get update
                DEBIAN_FRONTEND=noninteractive apt-get install -y \
                    openssh-server ca-certificates curl git tar gzip xz-utils
            fi

            mkdir -p /run/sshd /root/.ssh
            ssh-keygen -A >/dev/null 2>&1 || true
            printf '%s\n' 'root:$password' | chpasswd

            if grep -q '^#*PermitRootLogin' /etc/ssh/sshd_config; then
                sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
            else
                printf '\nPermitRootLogin yes\n' >> /etc/ssh/sshd_config
            fi

            if grep -q '^#*PasswordAuthentication' /etc/ssh/sshd_config; then
                sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
            else
                printf 'PasswordAuthentication yes\n' >> /etc/ssh/sshd_config
            fi
        "
}

start_debian_ssh() {
    prepare_debian_ssh || return 1

    local pid_file="$PID_DIR/debian-proot-sshd.pid"
    local pid
    pid="$(read_pid "$pid_file")"

    if ! safe_pid_alive "$pid"; then
        rm -f "$pid_file"

        echo "[+] Starting Debian/PRoot SSH on :$DEBIAN_SSH_PORT..."
        nohup proot-distro login "$DEBIAN_DISTRO" \
            --bind "$PROJECT_DIR:$DEBIAN_PROJECT" \
            -- bash -lc \
            "mkdir -p /run/sshd && exec /usr/sbin/sshd -D -e -p $DEBIAN_SSH_PORT" \
            > "$LOG_DIR/debian-sshd.log" 2>&1 &

        pid=$!
        printf '%s\n' "$pid" > "$pid_file"
        sleep 3
    fi

    local password
    password="$(cat "$DEBIAN_PASSWORD_FILE" 2>/dev/null || true)"

    echo
    echo "============================================================"
    echo " 🧪 VS CODE REMOTE-SSH VIA DEBIAN / PROOT"
    echo "============================================================"
    echo "Host     : $IP_LOCAL"
    echo "Port     : $DEBIAN_SSH_PORT"
    echo "User     : root"
    echo "Project  : $DEBIAN_PROJECT"
    [[ -n "$password" ]] && echo "Password : $password"
    echo
    echo "From Windows:"
    echo "  ssh root@$IP_LOCAL -p $DEBIAN_SSH_PORT"
}

service_state() {
    local label="$1"
    local port="$2"
    local pid_file="${3:-}"
    local pid=""

    [[ -n "$pid_file" ]] && pid="$(read_pid "$pid_file")"

    if safe_pid_alive "$pid"; then
        printf "✅ %-24s :%s  PID %s\n" "$label" "$port" "$pid"
    elif port_listening "$port"; then
        printf "✅ %-24s :%s  external/unmanaged\n" "$label" "$port"
    else
        printf "⏸  %-24s :%s\n" "$label" "$port"
    fi
}

show_status() {
    echo
    echo "============================================================"
    echo " DEV ENVIRONMENT STATUS"
    echo "============================================================"
    echo "Project: $PROJECT_DIR"
    echo "IP     : $IP_LOCAL"
    echo

    service_state "SSH Termux / SSH FS" "$SSH_PORT" "$PID_DIR/termux-sshd.pid"
    service_state "code-server" "$CODE_SERVER_PORT" "$PID_DIR/code-server.pid"
    service_state "Debian/PRoot SSH" "$DEBIAN_SSH_PORT" "$PID_DIR/debian-proot-sshd.pid"

    echo
    echo "Ollama/Gemma: OUTSIDE THIS SCRIPT"
}

stop_managed_pid() {
    local name="$1"
    local pid_file="$2"
    local pid

    pid="$(read_pid "$pid_file")"

    if ! safe_pid_alive "$pid"; then
        rm -f "$pid_file"
        echo "ℹ️ $name was not managed by this script."
        return
    fi

    echo "[+] Stopping $name (PID $pid)..."
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1

    if safe_pid_alive "$pid"; then
        kill -KILL "$pid" 2>/dev/null || true
    fi

    rm -f "$pid_file"
}

stop_dev_services() {
    echo
    echo "Only DEV services started by this script will be stopped."
    echo "Ollama/Gemma will not be touched."
    echo

    stop_managed_pid "code-server" "$PID_DIR/code-server.pid"
    stop_managed_pid "Debian/PRoot SSH" "$PID_DIR/debian-proot-sshd.pid"
    stop_managed_pid "SSH Termux" "$PID_DIR/termux-sshd.pid"

    echo
    echo "✅ DEV cleanup complete."
}

main_menu() {
    while true; do
        clear

        echo "============================================================"
        echo " 🚀 AnSysWarden · DEVELOPMENT ENVIRONMENT"
        echo "    S25 Ultra <-> VS Code Windows"
        echo "============================================================"
        echo
        echo "📡 IP      : $IP_LOCAL"
        echo "👤 User    : $USER_NAME"
        echo "📁 Project : $PROJECT_DIR"
        echo
        echo "1) VS Code Windows + SSH FS        [RECOMMENDED]"
        echo "   └─ SSH Termux :$SSH_PORT"
        echo
        echo "2) VS Code Web / code-server       [FALLBACK]"
        echo "   └─ http://$IP_LOCAL:$CODE_SERVER_PORT"
        echo
        echo "3) Direct SSH to Termux"
        echo "   └─ ssh $USER_NAME@$IP_LOCAL -p $SSH_PORT"
        echo
        echo "4) VS Code Remote-SSH via Debian   [EXPERIMENTAL]"
        echo "   └─ Debian/PRoot :$DEBIAN_SSH_PORT"
        echo
        echo "5) Start SSH + code-server"
        echo
        echo "6) Show DEV environment status"
        echo
        echo "7) Stop DEV services started by this script"
        echo
        echo "0) Exit"
        echo
        echo "============================================================"
        echo "This script does NOT manage Ollama, Gemma, or inference."
        echo "============================================================"
        echo

        read -r -p "Select an option [0-7]: " option

        case "$option" in
            1)
                show_sshfs_info
                pause_screen
                ;;
            2)
                start_code_server
                pause_screen
                ;;
            3)
                start_termux_ssh
                echo
                echo "SSH:"
                echo "  ssh $USER_NAME@$IP_LOCAL -p $SSH_PORT"
                pause_screen
                ;;
            4)
                start_debian_ssh
                pause_screen
                ;;
            5)
                start_termux_ssh
                echo
                start_code_server
                pause_screen
                ;;
            6)
                show_status
                pause_screen
                ;;
            7)
                stop_dev_services
                pause_screen
                ;;
            0)
                echo
                echo "Exiting."
                echo "Services remain active unless you use option 7."
                exit 0
                ;;
            *)
                echo
                echo "❌ Invalid option."
                sleep 1
                ;;
        esac
    done
}

if ! is_termux; then
    echo "❌ Run this script inside Termux on the S25 Ultra."
    exit 1
fi

ensure_termux_base || exit 1
load_ip "${1:-}"

if [[ ! -d "$PROJECT_DIR" ]]; then
    echo "❌ Project directory does not exist:"
    echo "   $PROJECT_DIR"
    exit 1
fi

main_menu
