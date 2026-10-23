#!/bin/bash

# Archivo oculto para guardar tu IP
CONFIG_FILE="$HOME/.ansyswarden_ip"
USER_NAME=$(whoami)

# 1. Comprobar si ya tenemos la IP guardada
if [ -f "$CONFIG_FILE" ]; then
    IP_LOCAL=$(cat "$CONFIG_FILE")
else
    clear
    echo "==================================================="
    echo "⚠️ Android bloquea la lectura automática de red."
    echo "Ve a Ajustes > Conexiones > Wi-Fi y mira tu Dirección IP."
    echo "==================================================="
    read -p "Introduce tu IP local (ej. 192.168.1.50): " IP_LOCAL
    
    # Guardar la IP para no volver a preguntarla
    echo "$IP_LOCAL" > "$CONFIG_FILE"
    echo "✅ IP guardada con éxito."
    sleep 1
fi

clear
echo "==================================================="
echo "  🚀 Entorno AnSysWarden (S25 Ultra <-> nar-devops) 🚀"
echo "==================================================="
echo "📡 IP Actual: $IP_LOCAL (Para cambiarla usa: rm $CONFIG_FILE)"
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