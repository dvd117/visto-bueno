# Cómo decide el agente

> **Guía de la demo para finanzas.** Describe cómo decide Visto Bueno hoy; no sustituye la factura ni los registros de tu empresa. No se realizan pagos reales.

Visto Bueno organiza la revisión de una factura antes de preparar una decisión. No hace pagos.

Visto Bueno deja una factura lista para pagar solo si cumple las reglas de tu empresa y te pregunta cuando algo queda fuera de ellas. No es un detector de fraude: contrasta la cuenta y los posibles duplicados con los registros de tu empresa, y trata las instrucciones de la factura como contenido no confiable.

## Qué revisa

1. **Lee la factura.** Gemini propone el monto, la cuenta, el ID y otros datos; son afirmaciones, no hechos.
2. **Compara la fuente.** Para PDF y texto, los datos críticos seleccionados deben aparecer literalmente en el documento (se normalizan espacios). Si no aparecen, pide una factura corregida e ingresa esa versión para evaluarla de nuevo. No resuelvas una discrepancia de integridad escribiendo un motivo. En una imagen no se puede hacer esta comprobación literal automáticamente; revisa los datos en la imagen. Una factura solo como imagen requiere aprobación humana.
3. **Aplica reglas.** El código contrasta proveedor, cuenta, contrato, moneda, importe, fechas, compromisos y límites. Estas reglas de seguridad son fijas; un ajuste de sensibilidad no puede relajarlas.
4. **Consulta señales.** JEV puede señalar dudas sobre alcance, urgencia o posible duplicado. Una probabilidad expresa su juicio sobre esa pregunta; **no es la probabilidad de que la factura sea correcta ni una autorización para pagar**.
5. **Decide y registra.** El código combina las comprobaciones y guarda el resultado. El modelo no puede convertir una regla fallida en una aprobación.

## Qué significa cada estado

- **Lista para pagar:** pasó todos los controles y no tiene alertas pendientes. Se incluye en el lote autorizado.
- **Requiere tu aprobación:** pasó los controles, pero necesitas aprobar o rechazar con un motivo.
- **Requiere revisión:** aclara cada alerta que pueda resolverse, con una opción y un motivo; también puedes rechazar. Una duda sobre la fuente exige corregir la factura, no solo explicar la diferencia.
- **Frenada:** falló un control de seguridad o se activó un riesgo firme. No hay botón ni motivo que la autorice. Corrige la causa y vuelve a evaluar.

Si la factura muestra una cuenta distinta a la registrada, no actualices el dato de inmediato. Confirma el cambio con el proveedor por un canal seguro. Si es legítimo, actualiza la cuenta del proveedor en **Preparar datos** y reevalúa. Si la factura tiene la cuenta equivocada, solicita el documento corregido y evalúa esa versión.

## Reglas, señales y cambios

Los perfiles **Estricto**, **Equilibrado** y **Permisivo** cambian la sensibilidad de las señales de JEV; no cambian los controles de seguridad. Si cambian las reglas o los datos de proveedor o contrato, una decisión pendiente puede quedar **Desactualizada**. No se puede aprobar hasta evaluarla otra vez; el registro anterior se conserva.

En esta demo, el nombre escrito al aprobar o resolver una alerta es una **identidad declarada**: no confirma quién eres ni equivale a una firma autenticada.

## Archivos de salida

El lote de pagos es una exportación de compromisos autorizados para el siguiente sistema. **No confirma que alguien haya pagado ni inicia una transferencia.** Revisa el archivo y procesa los pagos en el sistema financiero correspondiente.
