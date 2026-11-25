# 05 · IA, contexto, candidatos y benchmarks

**Para qué sirve:** distinguir detección de contexto, selección de candidatos,
comparación de modelos y pruebas de rendimiento.

```bash
./ansys test context
./ansys test candidates
./ansys test benchmark --offset 0 --limit 10
./ansys test models --models gemma4:e2b,gemma2:2b
./ansys test mobile-models
```

- **Contexto y candidatos:** pruebas locales; pueden utilizar carpetas
  temporales sintéticas.
- **Benchmark y modelos:** pueden requerir Ollama o los modelos indicados,
  consumir tiempo y producir trazas.

Los datasets (`cache-benchmark-100.ts` y `model-comparison-dataset.ts`)
están junto a sus ejecutores y no son scripts que debas arrancar solos.
