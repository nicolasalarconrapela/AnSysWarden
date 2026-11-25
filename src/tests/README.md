# Compatibilidad de rutas de pruebas

Las pruebas reales están organizadas en [`tests/`](../../tests/README.md).
Los archivos `.ts` de esta carpeta son **accesos de compatibilidad** y no
contienen lógica duplicada. Se conservan para que comandos antiguos como:

```bash
./node_modules/.bin/tsx src/tests/pc-dust-scan-contract-cli.ts
```

sigan funcionando. Para nuevas pruebas utiliza las carpetas
`tests/01-contratos/` … `tests/06-e2e/`.
