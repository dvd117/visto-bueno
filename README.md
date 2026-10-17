# Visto Bueno

Una factura llega por correo, PDF o chat; un cambio de cuenta puede desviar un pago. Visto Bueno contrasta cada factura con su fuente, los registros y las reglas de la empresa antes de preparar una decisión. El modelo aporta señales; **el código conserva la autoridad final**.

## Demo

[visto-bueno.aragort.com](https://visto-bueno.aragort.com) — demo de **Andina Labs Inc.**, con datos ficticios. No se ejecutan pagos reales.

> **Estado de implementación (checkout local):** el flujo de facturas, sus controles, reglas, datos, bitácora y evaluación están integrados. `GET /api/eval` sirve el artefacto validado `src/server/eval/report.json` (20/20 estados correctos, 0 aprobaciones indebidas en 30 pruebas adversariales). `EXTRACT_MODE=replay` y `JEV_MODE=replay` permiten probar sin llamadas externas. La disponibilidad de la URL desplegada debe verificarse por separado.

## Cómo decide

```text
Factura (PDF, imagen o texto)
  → 1. EXTRAER       Gemini propone datos; no se consideran hechos
  → 2. VERIFICAR     código compara los datos con la fuente y los registros
  → 3. APLICAR REGLAS código ejecuta controles deterministas
  → 4. JUZGAR        JEV evalúa señales con preguntas tipadas
  → 5. COMBINAR      código calcula estado, motivos y si permite aprobar
  → 6. REGISTRAR     código guarda la decisión, sus datos y un sello
```

En PDF, el texto se extrae primero en código; las imágenes se envían para lectura. La extracción es una afirmación que debe verificarse. Para montos, cuentas, identificación fiscal e ID de factura, el valor seleccionado debe aparecer literalmente en la fuente (se normalizan espacios). Las reglas comprueban, entre otras cosas, proveedor y cuenta registrados, contrato, moneda, monto, fechas, duplicados, límites, presupuesto y saldo disponible.

JEV aporta juicio sobre señales como urgencia artificial, alcance o posible duplicado. Sus probabilidades son señales para esas preguntas, no autorización ni garantía. Los perfiles **Estricto**, **Equilibrado** y **Permisivo** ajustan la sensibilidad de JEV; no desbloquean ni relajan controles fijos. El código combina las verificaciones, las reglas y las señales. Un error o una respuesta incompleta de JEV impide la decisión automática de pago.

En un lote, extracción y juicio pueden ejecutarse en paralelo. Verificación, reglas, combinación y registro se hacen en secuencia, una factura por transacción, para que cada decisión considere los compromisos anteriores.

### Estados y qué hacer

| Estado | Qué significa | Acción humana |
|---|---|---|
| **Lista para pagar** | Pasó los controles deterministas, no tiene alertas pendientes y está dentro del límite de pago automático. | No requiere aprobación; aparece en el lote de pagos autorizado. |
| **Requiere tu aprobación** | Pasó los controles, pero una regla exige autoridad humana. | Aprobar o rechazar con un motivo. |
| **Requiere revisión** | Hay una señal de juicio o incertidumbre que necesita aclaración. | Resolver cada alerta válida con una opción y un motivo, o rechazar. |
| **Frenada** | Falló un control determinista o se activó un riesgo firme. | No se puede aprobar ni sobrescribir. Corrige la causa y vuelve a evaluar. |

En este flujo, **comprometido no significa pagado**. El lote es un archivo para el siguiente sistema; no inicia una transferencia.

Una alerta de integridad no se corrige con una explicación: si un dato crítico no coincide con el documento, solicita la factura corregida, ingresa esa versión y evalúala de nuevo. Si la cuenta bancaria de la factura cambió, verifica el cambio con el proveedor por un canal seguro; solo después actualiza el registro del proveedor en **Preparar datos** y vuelve a evaluar. No sustituyas la cuenta de la factura por la registrada.

Al aprobar, el servidor vuelve a comprobar los controles contra los datos y compromisos actuales dentro de una transacción. Guarda juntos la decisión, el compromiso y el evento de auditoría; si un control ya no pasa, rechaza la aprobación. Cada espacio de trabajo mantiene sus propios datos de demo. **Reiniciar demo** restablece ese espacio a los datos ficticios sembrados.

Cambiar reglas o datos de proveedor o contrato puede dejar una decisión pendiente **Desactualizada**. No se puede aprobar hasta ejecutar una nueva evaluación; el registro anterior se conserva y la nueva decisión queda enlazada.

## Ejecución local

Requiere Node.js 22. Los modos de extracción y juicio usan `replay` por defecto: leen respuestas grabadas y no necesitan llaves ni hacen llamadas externas.

```sh
npm ci
npm test
npm run build
npm run dev
```

`npm run dev` levanta Vite en `127.0.0.1:5173` y el servidor en `127.0.0.1:3000`. Para arrancar el servidor con la compilación de producción: `npm run build && npm start` (puerto predeterminado `3000`).

Variables relevantes de `.env.example` (los secretos se quedan vacíos; no pongas llaves en el repositorio):

```dotenv
TYPESAFE_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=
JEV_MODE=replay
JEV_MODEL=jev-latest
EXTRACT_MODE=replay
DB_PATH=./data/visto-bueno.db
LIVE_DAILY_CAP=300
TRUST_PROXY=1
```

`replay` no consulta servicios externos. `record` guarda respuestas de llamadas reales para repetirlas; `live` realiza llamadas reales. Nunca se fabrican respuestas de grabación. Presenta una corrida en vivo por separado e identifica el modelo, la latencia, los errores y el uso de tokens observados.

## Evaluación y costo

El informe de evaluación lo genera una ejecución local de pruebas de confianza; su estructura, por sí sola, no demuestra su procedencia.

- **Seguridad de regresión:** 0 aprobaciones indebidas en 30 pruebas adversariales.
- **Conjunto etiquetado:** 20/20 estados correctos, 0 falsos escalamientos y 75 % de autonomía, en respuestas grabadas.
- **Muestra en vivo:** Sin muestra en vivo; requiere facturas no vistas y latencia, costo y fallos medidos.
- **Costo por 1.000 facturas:** Pendiente de medición. Para calcularlo hacen falta los modelos y llamadas por factura, tokens de entrada y salida de extracción y JEV, y las tarifas aplicables en la fecha de medición.

### Costo por factura

La extracción registra `usageMetadata` de Gemini por llamada. El costo estimado suma tokens de entrada a USD 0,25 y tokens de salida (candidatos y razonamiento) a USD 1,50 por millón para `gemini-3.1-flash-lite`, según la tarifa Standard de la [API Gemini Developer](https://ai.google.dev/gemini-api/docs/pricing). Si falta el uso registrado, el costo queda desconocido.

**Costo medido por factura:** USD 0,00075 en promedio (USD 0,0150 por las 20 facturas etiquetadas), medido el 17-10-2026 con una sola llamada real por factura, sin reintentos: 9.948 tokens de entrada y 8.309 de salida en total. Por tipo: texto USD 0,00074 (3), PDF USD 0,00073 (16), imagen USD 0,00106 (1).

Estas tres evidencias —seguridad, conjunto etiquetado y muestra en vivo— se mantienen separadas; una no sustituye a otra.

## Límites

- El plan contempla Gemini en nivel gratuito para la demo y una cuenta pagada para producción. Confirma el plan, la cuota y la disponibilidad vigentes antes de habilitar llamadas en vivo.
- Los datos son ficticios y ningún archivo exportado ejecuta un pago.

## Stack

TypeScript, React, Vite, Hono, SQLite (`better-sqlite3`), `decimal.js` y Vitest. Gemini se usa para proponer datos extraídos; JEV, para juicio tipado. Ningún modelo escribe la explicación final de una decisión.

Consulta [Cómo decide el agente](docs/help/como-decide.md) para la guía breve dirigida a finanzas.
