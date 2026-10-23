#!/bin/bash

clear
echo "==================================================="
echo "  📦 Verificando dependencias de AnSysWarden..."
echo "==================================================="

# 1. AUTO-INSTALADOR DE DEPENDENCIAS
if ! command -v sshd >/dev/null 2>&1; then
    echo "[+] Instalando OpenSSH (para Método 1)..."
    pkg install openssh -y
fi

if ! command -v python >/dev/null 2>&1; then
    echo "[+] Instalando Python (para extraer IP de Android)..."
    pkg install python -y
fi

if ! command -v node >/dev/null 2>&1; then
    echo "[+] Instalando Node.js (base del proyecto)..."
    pkg install nodejs -y
fi

if ! command -v code-server >/dev/null 2>&1; then
    echo "[+] Instalando code-server (para Método 2)..."
    echo "    (Esto puede tardar un par de minutos la primera vez)"
    npm install -g code-server
fi

# 2. GESTIÓN DE LA IP
CONFIG_FILE="$HOME/.ansyswarden_ip"
USER_NAME=$(whoami)
IP_LOCAL=""

# Si pasas el argumento -r o --reset-ip, borra el archivo de configuración
if [[ "$1" == "-r" || "$1" == "--reset-ip" ]]; then
    echo "[+] Reseteando la configuración de red..."
    rm -f "$CONFIG_FILE"
fi

if [ -f "$CONFIG_FILE" ]; then
    IP_LOCAL=$(cat "$CONFIG_FILE")
else
    # Intento de detección nativa: El truco del socket UDP con Python
    if command -v python >/dev/null 2>&1; then
        IP_LOCAL=$(python -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()" 2>/dev/null)
    fi

    # Fallback: El truco del socket UDP con Node.js
    if [ -z "$IP_LOCAL" ] && command -v node >/dev/null 2>&1; then
        IP_LOCAL=$(node -e "const dgram = require('dgram'); const s = dgram.createSocket('udp4'); s.connect(80, '8.8.8.8', () => { console.log(s.address().address); s.close(); });" 2>/dev/null)
    fi

    # Si todo falla, pedirla a mano
    if [ -z "$IP_LOCAL" ]; then
        echo "⚠️ Android ha bloqueado la lectura automática de red."
        read -p "Introduce tu IP local (ej. 192.168.1.59): " IP_LOCAL
    fi
    
    echo "$IP_LOCAL" > "$CONFIG_FILE"
    sleep 1
fi

# 3. INTERFAZ DE ARRANQUE
clear
echo "==================================================="
echo "  🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops) 🚀"
echo "==================================================="
echo "📡 IP Actual: $IP_LOCAL"
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
    sshd
    echo "✅ SSH Activo. En el VS Code de tu portátil, conéctate a:"
    echo "👉 ssh $USER_NAME@$IP_LOCAL -p 8022"
fi

if [[ "$OPCION" == "2" || "$OPCION" == "3" ]]; then
    echo -e "\n[+] Iniciando code-server (Puerto 8080)..."
    code-server --auth none --bind-addr 0.0.0.0:8080 > code-server.log 2>&1 &
    echo "✅ Web IDE Activo. Abre esta URL en el Chrome de tu portátil:"
    echo "👉 http://$IP_LOCAL:8080"
fi

echo -e "\n==================================================="
echo "Listo. Deja esta terminal abierta mientras programas."