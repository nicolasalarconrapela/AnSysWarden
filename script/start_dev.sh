#!/bin/bash

clear
echo "==================================================="
echo "  📦 Verificando dependencias de AnSysWarden..."
echo "==================================================="

# 1. AUTO-INSTALADOR SMART (Detecta Termux vs Debian)
if ! command -v sshd >/dev/null 2>&1; then
    echo "[+] Instalando OpenSSH (para Método 1)..."
    if [[ "$PREFIX" == *"/com.termux/"* ]]; then pkg install openssh -y; else apt update && apt install openssh-server -y; fi
fi

if ! command -v python >/dev/null 2>&1; then
    echo "[+] Instalando Python (para extraer IP de Android)..."
    if [[ "$PREFIX" == *"/com.termux/"* ]]; then pkg install python -y; else apt update && apt install python3 -y; fi
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[+] Instalando Node.js (base del proyecto)..."
    if [[ "$PREFIX" == *"/com.termux/"* ]]; then pkg install nodejs -y; else apt update && apt install nodejs -y; fi
fi

if ! command -v code-server >/dev/null 2>&1; then
    echo "[+] Instalando code-server de forma nativa..."
    if [[ "$PREFIX" == *"/com.termux/"* ]]; then
        pkg install tur-repo -y && pkg install code-server -y
    else
        if ! command -v curl >/dev/null 2>&1; then apt update && apt install curl -y; fi
        curl -fsSL https://code-server.dev/install.sh | sh
    fi
fi

# 2. CONFIGURACIÓN DEL DIRECTORIO
PROJECT_DIR="$HOME/AnSysWarden"
mkdir -p "$PROJECT_DIR"

# 3. GESTIÓN DE LA IP
CONFIG_FILE="$HOME/.ansyswarden_ip"
USER_NAME=$(whoami)
IP_LOCAL=""

if [[ "$1" == "-r" || "$1" == "--reset-ip" ]]; then
    rm -f "$CONFIG_FILE"
fi

if [ -f "$CONFIG_FILE" ]; then
    IP_LOCAL=$(cat "$CONFIG_FILE")
else
    if command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
        CMD_PYTHON=$({ command -v python || command -v python3; } 2>/dev/null)
        IP_LOCAL=$($CMD_PYTHON -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()" 2>/dev/null)
    fi

    if [ -z "$IP_LOCAL" ] && command -v node >/dev/null 2>&1; then
        IP_LOCAL=$(node -e "const dgram = require('dgram'); const s = dgram.createSocket('udp4'); s.connect(80, '8.8.8.8', () => { console.log(s.address().address); s.close(); });" 2>/dev/null)
    fi

    if [ -z "$IP_LOCAL" ]; then
        echo "⚠️ Android ha bloqueado la lectura automática de red."
        read -p "Introduce tu IP local (ej. 192.168.1.59): " IP_LOCAL
    fi
    
    echo "$IP_LOCAL" > "$CONFIG_FILE"
fi

# 4. INTERFAZ DE ARRANQUE
clear
echo "==================================================="
echo "  🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops) 🚀"
echo "==================================================="
echo "📡 IP Actual: $IP_LOCAL"
echo "📁 Directorio: $PROJECT_DIR"
echo "💡 (Si cambias de Wi-Fi, ejecuta: ./start_dev.sh -r)"
echo "==================================================="
echo "Elige cómo quieres abrir tu código en el PC:"
echo "1) Método 1: VS Code Nativo (Extensión Remote-SSH)"
echo "2) Método 2: VS Code en Navegador (code-server)"
echo "3) Levantar ambos servicios"
echo "==================================================="
read -p "Selecciona una opción [1-3]: " OPCION

if [[ "$OPCION" == "1" || "$OPCION" == "3" ]]; then
    echo -e "\n[+] Iniciando servidor SSH (Puerto 8022)..."
    if [[ "$PREFIX" == *"/com.termux/"* ]]; then sshd; else service ssh start 2>/dev/null || /etc/init.d/ssh start 2>/dev/null; fi
    echo "✅ SSH Activo. Comando para tu PC:"
    echo "👉 ssh $USER_NAME@$IP_LOCAL -p 8022"
fi

if [[ "$OPCION" == "2" || "$OPCION" == "3" ]]; then
    echo -e "\n[+] Iniciando code-server en $PROJECT_DIR..."
    code-server --auth none --bind-addr 0.0.0.0:8080 "$PROJECT_DIR" > code-server.log 2>&1 &
    echo "✅ Web IDE Activo. URL para tu PC:"
    echo "👉 http://$IP_LOCAL:8080"
fi

# 5. MODO ESCUCHA Y CIERRE LIMPIO
echo -e "\n==================================================="
echo "🟢 SERVICIOS EN EJECUCIÓN"
echo "==================================================="
read -p "🛑 Presiona [ENTER] en cualquier momento para apagar los servidores y salir..." 

echo -e "\n[!] Deteniendo servicios..."
pkill sshd 2>/dev/null
pkill -f code-server 2>/dev/null
echo "✅ Entorno cerrado de forma segura."