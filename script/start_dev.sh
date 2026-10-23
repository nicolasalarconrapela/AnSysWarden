#!/bin/bash

# Obtener usuario y la IP de la Wi-Fi
USER_NAME=$(whoami)
IP_LOCAL=$(ifconfig wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}')

# Si ifconfig falla, usar un valor genérico
if [ -z "$IP_LOCAL" ]; then
    IP_LOCAL="<IP_DE_TU_MOVIL>"
fi

clear
echo "==================================================="
echo "  🚀 Entorno Híbrido S25 Ultra <-> nar-devops 🚀"
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
    # Se lanza en segundo plano enviando los logs a un archivo
    code-server --auth none --bind-addr 0.0.0.0:8080 > code-server.log 2>&1 &
    echo "✅ Web IDE Activo. Abre esta URL en el Chrome de tu portátil:"
    echo "👉 http://$IP_LOCAL:8080"
fi

echo -e "\n==================================================="
echo "Listo. Deja esta terminal abierta mientras programas."