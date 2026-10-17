# Grabación genuina del set JEV

Ejecutar desde la raíz del repositorio, en el entorno privado de coordinación con `TYPESAFE_API_KEY` inyectada por el gestor de secretos:

```sh
EXTRACT_MODE=replay JEV_MODE=record npm run record:jev
```

El script recorre las 20 facturas etiquetadas con el `processBatch` canónico, reutiliza las extracciones genuinas de `src/server/extract/recordings` y guarda solo las respuestas JEV válidas en `recordings/`. Usa una base SQLite en memoria y no crea el limitador de llamadas del demo; por tanto, la grabación no consume cuotas demo. Sí realiza llamadas facturables al proveedor JEV. No carga `.env`, imprime claves ni muestra contenido de respuestas. Sale con error si no quedan grabadas las 20 respuestas.

Si se define `JEV_MODEL`, mantener el mismo valor al grabar y ejecutar el gate de replay; si se omite, ambos usan `jev-latest`.

Después de que el script termine correctamente, correr el gate de replay sin llamadas de proveedor:

```sh
EXTRACT_MODE=replay JEV_MODE=replay npm test -- tests/server/api.test.ts -t 'replays the genuine sample'
```

Con las 20 grabaciones completas, esa prueba compara los 20 estados del pipeline con `fixtures/invoices/labels.json` y falla si un estado `ready` no está etiquetado `ready`. Sin grabaciones completas, no presenta métricas ni declara el gate etiquetado disponible.
