# 03 · Tree y visor HTML

**Para qué sirve:** verificar reglas de Tree y la representación de una
captura en el navegador.

La prueba automática existente (`tree-policy-cli.ts`) valida **políticas
de Tree**, **NO** la apariencia de HTML. La auditoría visual sigue pendiente
hasta revisarla con un navegador.

```bash
./ansys test tree
./ansys tree view --latest --out "tests/resultados/03-visor-html/visor_prueba.html"
./ansys tree show --depth 8 --files
```

## Comprobación visual manual

- [ ] Aparecen los archivos y carpetas de la fixture, incluidas las vacías.
- [ ] Los nombres con espacios, tildes y ñ se muestran completos.
- [ ] Tamaños y fechas legibles, sin superposiciones ni columnas cortadas.
- [ ] Se puede expandir y contraer, conservando la navegación.
- [ ] El HTML y el árbol de terminal representan la misma captura.
- [ ] Un nombre con `KEEP` se muestra sin recomendar borrado.
- [ ] Consultar `--latest` no dispara un segundo escaneo.

Puedes guardar el HTML aquí, pero sigue siendo un resultado **local** y
**no versionado**. Si necesitas mantener varios resultados, utiliza un nombre
que incluya el identificador de la captura. Los índices originales siguen en
`.ansyswarden/tree/scans/`.

## FASE 04.A · Puerta de revisión humana antes de Gemma

```bash
# Prueba sintética sin red ni archivos personales:
./node_modules/.bin/tsx tests/03-visor-html/tree-ai-review-cli.ts

# Genera revisión offline de la captura Tree guardada:
./ansys tree ai-preview --latest --out revision_ia.html
```

Abre `revision_ia.html`. Valida que aparezcan carpetas conocidas, bloqueos
de `backups` y `KEEP`, recuentos y limitación a 60 carpetas. No hay selección
automática. Marca únicamente carpetas revisables, pulsa «Mostrar JSON» y
comprueba que el JSON **no incluya rutas ni nombres** antes de exportarlo.

**Importante:** el HTML sí contiene rutas reales y no debe compartirse. El JSON
descargado sigue siendo una **propuesta para revisión posterior**, sin red ni
permiso de borrado. Si hay errores en la captura, ninguna carpeta es aprobable.
