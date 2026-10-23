#!/bin/bash

CONFIG_FILE="$HOME/.ansyswarden_ip"
USER_NAME=$(whoami)
IP_LOCAL=""

# 1. Intento de detección nativa (Linux estándar)
IP_LOCAL=$(ip -4 addr show 2>/dev/null | grep inet | grep -v '127.0.0.1' | awk '{print $2}' | cut -d/ -f1 | head -n 1)

# 2. Intento vía Node.js (Si 'ip' está bloqueado pero Node tiene permisos)
if [ -z "$IP_LOCAL" ] && command -v node >/dev/null 2>&1; then
    IP_LOCAL=$(node -e "const os = require('os'); const nets = os.networkInterfaces(); for (const name of Object.keys(nets)) { for (const net of nets[name]) { if (net.family === 'IPv4' && !net.internal) console.log(net.address); } }" 2>/dev/null | head -n 1)
fi

# 3. Intento vía ifconfig (Rutas antiguas)
if [ -z "$IP_LOCAL" ]; then
    IP_LOCAL=$(ifconfig wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}')
fi

# 4. Si TODO falla (Restricción estricta de Android) usamos la guardada o preguntamos
if [ -z "$IP_LOCAL" ]; then
    if [ -f "$CONFIG_FILE" ]; then
        IP_LOCAL=$(cat "$CONFIG_FILE")
    else
        clear
        echo "==================================================="
        echo "⚠️ Android ha bloqueado la lectura automática de red."
        echo "Ve a Ajustes > Conexiones > Wi-Fi y copia tu Dirección IP."
        echo "==================================================="
        read -p "Introduce tu IP local (ej. 192.168.1.50): " IP_LOCAL
        echo "$IP_LOCAL" > "$CONFIG_FILE"
        echo "✅ IP guardada en caché."
        sleep 1
    fi
else
    # Si la detectó automáticamente, actualizamos el caché silenciosamente por si cambiaste de red
    echo "$IP_LOCAL" > "$CONFIG_FILE"
fi

clear
echo "==================================================="
echo "  🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops) 🚀"
echo "==================================================="
echo "📡 IP Actual: $IP_LOCAL (Borra $CONFIG_FILE para resetearla)"
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