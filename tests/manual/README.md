# Scripts de prueba manuales

Scripts de desarrollo ejecutables a mano (no forman parte del CI ni de
`cargo test`). Ejecutar desde la raíz del repo, p. ej.:

```
python tests/manual/test_pipeline_e2e.py
```

Requieren el sidecar Python en marcha (`:8731`) salvo que el propio script
indique lo contrario. Son utilidades de diagnóstico, no tests automatizados.
