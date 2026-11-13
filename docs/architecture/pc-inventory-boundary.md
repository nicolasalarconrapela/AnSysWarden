# PC · Primer límite hexagonal del inventario

Base: `develop` en `8f8cb82ba7eb506b5a0ded7fe2324fcd59637447`.

## Responsabilidades

- `src/core/inventory/tree-types.ts`: contrato interno del inventario del PC, sin referencias a Node, HTML o Gemma.
- `src/application/tree/ports/tree-inventory-scanner.port.ts`: puerto de salida del caso de uso.
- `src/application/tree/create-tree-inventory.ts`: caso de uso de escaneo.
- `src/infrastructure/filesystem/native-tree-scanner-adapter.ts`: adaptador que delega al scanner nativo existente.
- `src/tree/tree-cli.ts`: adaptador de entrada CLI, ahora conecta el caso de uso y el adaptador.
- `src/tree/native-tree-scanner.ts`: conserva implementación, esquema JSONL v1, rutas y metadatos; reexporta tipos anteriores para compatibilidad.

## Límite de desarrollo paralelo

La rama de PC no cambia `src/interfaces/worker/`, `src/infrastructure/ollama/` ni los contratos `src/core/contracts/backend-protocol.ts`.

El worker móvil no debe importar `src/tree/`, `src/application/tree/` o los adaptadores del PC.

El nuevo contrato de Tree es **interno del PC**, no un formato de trabajo compartido con la IA móvil.

## Garantías y límites

Este cambio **no** añade eliminación de archivos, clasificación IA ni migración de índices. El escáner real continúa leyendo el sistema de archivos y escribiendo sus índices y metadatos donde lo hacía antes. No se altera el formato `ansyswarden.tree-index.v1`.

La separación todavía es incremental: la implementación nativa sigue guardando JSONL. Una futura fase podrá extraer un puerto de persistencia sin cambiar el contrato de inventario ni el comando.

## Verificaciones pendientes de ejecutar

No ejecutar sin autorización explícita del usuario:

```bash
npm run typecheck
./node_modules/.bin/tsx src/tests/pc-inventory-boundary-cli.ts
./ansys tree scan "<carpeta-de-prueba>" --html prueba.html
./ansys tree audit
```

Criterios: `tree scan` conserva número de archivos y carpetas, tamaños, salida JSONL, HTML y errores; los tipos de Tree siguen disponibles desde `src/tree/native-tree-scanner.ts`; el caso de uso puede probarse con un escáner falso sin tocar discos.
