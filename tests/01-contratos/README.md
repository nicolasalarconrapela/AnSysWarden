# 01 · Contratos y argumentos

**Para qué sirve:** confirmar que Dust interpreta las opciones correctamente,
que genera el manifiesto previsto y que la aplicación de inventario delega
en su interfaz sin acceder directamente al disco.

```bash
./node_modules/.bin/tsx tests/01-contratos/pc-dust-scan-contract-cli.ts
./node_modules/.bin/tsx tests/01-contratos/pc-inventory-boundary-cli.ts
```

Y para verificar la organización sin escribir ni ejecutar los tests:\n\n```bash
node tests/01-contratos/validar-estructura.mjs
```\n\nEstas son pruebas de contrato (sin escanear carpetas personales). Los resultados
se muestran en la terminal; no generan automáticamente informes en disco.
