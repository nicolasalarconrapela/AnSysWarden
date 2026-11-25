# 04 · Seguridad

**Para qué sirve:** comprobar que las reglas protegen datos personales y
que la salida de IA no sustituye a las reglas de seguridad.

```bash
# Solo reglas deterministas, sin Ollama:
./ansys test rules

# Suite completa de seguridad con comprobaciones de modelo:
./ansys test safety
```

`ai-safety.ts` es la batería de casos importada por `test safety`; **no
es necesario ejecutarla directamente**. Esa suite requiere Ollama y un
modelo disponible; no es una prueba del inventario ni autoriza borrados.
