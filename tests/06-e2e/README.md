# 06 · Backend y extremo a extremo (E2E)

**Para qué sirve:** comprobar intercambios de datos en el backend y el
recorrido PC → móvil → PC, sin confundir un smoke test local con un E2E real.

```bash
# Smoke test JSON: usa un directorio temporal, sin red ni móvil.
./node_modules/.bin/tsx tests/06-e2e/backend-json-smoke-cli.ts tests/fixtures/backend-smoke.json

# E2E real: requiere el backend y el trabajador móvil arrancados.
./ansys test e2e --backend http://127.0.0.1:8787
```

El smoke test JSON no prueba conectividad de red. El E2E sí verifica
transporte y límites de autorización; debe ejecutarse deliberadamente
con los servicios ya preparados.
