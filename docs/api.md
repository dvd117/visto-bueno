# API

La especificación OpenAPI 3.1 está en `GET /api/openapi.json`.
Prueba los ejemplos con datos ficticios; este demo no realiza pagos reales.

```sh
BASE=https://visto-bueno.aragort.com
curl -sS -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"text":"Factura ficticia de Andina Labs por USD 1000"}' "$BASE/api/invoices" > invoice.json
ID=$(jq -r .id invoice.json)
curl -N -b cookies.txt -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d "{\"ids\":[\"$ID\"],\"mode\":\"replay\"}" "$BASE/api/process"
curl -sS -b cookies.txt "$BASE/api/invoices/$ID"
```

El primer acceso crea el workspace y entrega la cookie `workspace_id`; conserva el mismo cookie jar.
No apruebes ni rechaces desde una integración: son acciones humanas registradas con identidad declarada.
