# Resultados de pruebas (archivos locales)

Cada carpeta tiene el mismo nombre que su área de pruebas:

- `01-contratos/`
- `02-inventario/`
- `03-visor-html/`
- `04-seguridad/`
- `05-ia/`
- `06-e2e/`

Aquí puedes guardar HTML, logs o informes **si indicas expresamente una ruta
de salida**. Por ejemplo:

```bash
./ansys tree view --latest --out "tests/resultados/03-visor-html/visor_prueba.html"
```

**No se trasladan automáticamente** los índices, manifiestos y análisis del
producto: siguen en `.ansyswarden/tree/` para conservar `--latest`.
Tampoco se conservan por defecto los logs de cada comando: si quieres un
registro de terminal, redirígelo de forma voluntaria.

Los archivos generados se ignoran en Git, salvo estos README y archivos
`.gitkeep`. No subas datos sensibles ni tokens. Repetir `--out` con el
mismo nombre puede reemplazar tu HTML anterior.
