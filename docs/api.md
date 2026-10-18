# API

La especificación OpenAPI 3.1 está en `GET /api/openapi.json`.
Prueba los ejemplos con datos ficticios; este demo no realiza pagos reales.

Desde la raíz del repositorio, inicia el servidor local en modo de reproducción:

```sh
EXTRACT_MODE=replay JEV_MODE=replay npm run dev
```

En otra terminal, usa la factura de ejemplo sembrada por el workspace. Así el proceso usa una grabación existente y no intenta extraer una factura nueva:

```sh
BASE=http://127.0.0.1:3000
curl -sS -c cookies.txt "$BASE/api/invoices" > invoices.json
ID=$(jq -r '.[0].id' invoices.json)
curl -N -b cookies.txt -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d "{\"ids\":[\"$ID\"],\"mode\":\"replay\"}" "$BASE/api/process"
curl -sS -b cookies.txt "$BASE/api/invoices/$ID"
```

El primer acceso crea el workspace y entrega la cookie `workspace_id`; conserva el mismo cookie jar.
No apruebes ni rechaces desde una integración: son acciones humanas registradas con identidad declarada.

## Decidir una factura

`POST /api/v1/decide` recibe una factura y devuelve `state`, `headline`, `reasons`, `checks`, `sealId` y `decisionRecordId`. Requiere `Idempotency-Key`; la clave queda aislada por workspace y repetirla devuelve el mismo resultado. El endpoint registra la decisión, pero no aprueba ni ejecuta pagos.

Para procesar una factura de ejemplo en replay, usa un ID sembrado en el mismo workspace:

```sh
curl -sS -b cookies.txt -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-al030-1' \
  -d '{"invoiceId":"AL-030"}' "$BASE/api/v1/decide"
```

Para una factura nueva, envía texto JSON (`{"text":"..."}`) o un archivo PDF/imagen con `-F 'file=@factura.pdf'`. Esas entradas nuevas usan el modo live y los límites existentes por llamada a modelo; configura las credenciales de proveedor antes de probarlas. Un fallo de extracción o evaluación conserva el comportamiento fail-closed del pipeline.

## MCP Streamable HTTP

El servidor MCP funciona en el mismo proceso, en `POST /mcp` (Streamable HTTP). Cada sesión nueva recibe un workspace de demo sembrado; si la solicitud de inicialización incluye la cookie existente `workspace_id`, usa ese workspace. La sesión no puede elegir otro workspace mediante argumentos. Las herramientas son:

- `decide`: recibe `{invoiceId, idempotencyKey}`, `{text, idempotencyKey}` o `{file: {name, mimeType, contentBase64}, idempotencyKey}`. Los IDs sembrados (por ejemplo `AL-030`) se reproducen; el texto y los archivos nuevos usan el pipeline, los límites y la idempotencia de `POST /api/v1/decide` en modo live. Devuelve una decisión registrada, nunca aprueba ni rechaza.
- `explain(invoiceId)`: solo lectura; devuelve el expediente con historial, citas de evidencia y sello.
- `export_batch({readyIds?})`: devuelve como texto el CSV de pagos de la UI. Si se indican `readyIds`, incluye esas facturas listas; siempre incluye las ya aprobadas. Sin argumento, incluye todas las facturas listas elegibles y las aprobadas.

No existe una herramienta MCP para aprobar o rechazar; esas acciones siguen en la interfaz humana.

Con el servidor local iniciado en replay, conecta un inspector interactivo con:

```sh
npx @modelcontextprotocol/inspector
```

Selecciona **Streamable HTTP** y `http://127.0.0.1:3000/mcp`. Para conectar Claude Code al mismo endpoint:

```sh
claude mcp add --transport http visto-bueno http://127.0.0.1:3000/mcp
```
