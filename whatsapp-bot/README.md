# Bot de WhatsApp multi-cliente

Un producto para ofrecer a muchos negocios: les mandas el **formulario** (español o inglés), te lo regresan lleno, cargas sus datos con un comando y el asistente queda listo. Es un solo sistema; cada negocio vive aislado.
ArcoSodi Hotel Boutique (`clientes/arcosodi.json`) es solo el primer caso de prueba.

**Giros:** hotel, restaurante y "citas" (salón, barbería, taller, spa…). **Idiomas:** español e inglés a la vez: contesta en el idioma de quien escribe y traduce las respuestas del negocio. **Países:** México y Estados Unidos (zona horaria y formato de fecha propios: `3/4` es 4 de marzo en EE. UU.).

### Para quién sirve y para quién no
- **Sí:** hoteles, restaurantes, salones, barberías, talleres, gimnasios, spas, veterinarias… en México o EE. UU., sobre todo donde los clientes ya usan WhatsApp.
- **No (todavía): dentistas y clínicas en EE. UU.** WhatsApp no sirve para información de salud allí: Meta no firma el acuerdo de HIPAA (BAA) y su [política](https://business.whatsapp.com/policy) restringe datos de salud. Por eso el formulario pregunta si manejan información de salud, y **la base de datos se niega** a crear ese negocio (`sin_salud_en_us`). Para ellos la vía es SMS con un proveedor que firme BAA (otro canal; la lógica del bot se reutiliza) y un asesor de HIPAA. Ver fuentes al final.
- **Clínicas fuera de EE. UU. (p. ej. México):** se permite con avisos (consentimiento expreso, no guardar datos clínicos). El asistente pide no compartir información médica.
- En EE. UU. confirma que los clientes finales del negocio usan WhatsApp: allí domina el SMS.

## Cómo funciona

```
Cliente en WhatsApp ─▶ Meta (Cloud API oficial) ─▶ webhook de n8n
                                                        │
              ¿firma de Meta válida?  ── no ──▶ se ignora
                                                        │
                               Supabase (guarda el mensaje, trae datos del negocio)
                                                        │
                    reglas en español ──(entiende)──▶ responde con texto fijo del negocio
                          │ (no entiende)
                          └─▶ Claude Haiku (clasifica / contesta solo con datos del negocio)
                                                        │
        reserva: pregunta paso a paso ─▶ resumen ─▶ "SÍ" ─▶ Supabase ─▶ solicitud con folio
        queja / pide persona / 3 dudas sin resolver ─▶ aviso al dueño (plantilla) + el bot calla 30 min
                                                        │
                                   pausa 3–10 s ─▶ responde por la Cloud API ─▶ queda en el historial
```

Reglas que el bot respeta siempre:
- **No inventa**: precios, horarios y políticas salen de lo que el negocio escribió. Si falta el dato, dice que lo confirma una persona.
- **No confirma lo que no guardó**: la reserva es una *solicitud* con folio; solo se dice "recibida" si Supabase la guardó. Si falla, avisa a una persona.
- **Un bot que calla cuando entra una persona**: la conversación se pausa (`pausa_min`, 30 por defecto).
- **Aislamiento**: cada fila lleva su `cliente_id` y la seguridad por filas impide ver datos de otro negocio (probado).

## Carpetas

| Carpeta | Qué hay |
|---|---|
| `clientes/` | `formulario.json` (qué se le pide a cada negocio) y un JSON por cliente |
| `supabase/schema.sql` | tablas, seguridad por filas y funciones `bot_*` |
| `n8n/code/bot.cjs` | **toda la lógica** del bot (pura, sin red). Es la única fuente |
| `n8n/whatsapp-bot.workflow.json` | flujo de n8n generado (no se edita a mano) |
| `plantillas/` | plantillas de WhatsApp que se mandan a aprobar a Meta |
| `scripts/` | `build-workflow.mjs` y `cli.mjs` (todo el alta automatizado) |
| `formulario/` | formulario web que llenan los negocios |
| `tests/` | 59 pruebas rápidas + una prueba de punta a punta con un n8n real (`e2e-n8n.mjs`, 17 comprobaciones) |

## Comandos

```bash
npm install
npm test                                   # 59 pruebas, unos segundos
node scripts/cli.mjs validar clientes/arcosodi.json
node scripts/cli.mjs aplicar clientes/arcosodi.json --traducir --enviar   # Supabase (+ traduce las respuestas al otro idioma)
node scripts/cli.mjs plantillas --idioma=es --enviar             # Meta: plantillas (es o en)
node scripts/cli.mjs plantillas --estado                         # aprobadas / rechazadas y por qué
node scripts/cli.mjs n8n --enviar                                # credenciales + flujo + activar
node scripts/cli.mjs webhook-meta --enviar                       # registra el webhook en Meta
node scripts/cli.mjs probar 5219511234567 --enviar               # mensaje de prueba
```
Sin `--enviar` todo es **ensayo**: muestra qué haría y no toca nada. Los secretos se leen de variables de entorno y nunca se imprimen.

## Estado

| Pieza | Estado |
|---|---|
| Lógica del bot (reservas, escalamiento, fechas en español, IA acotada) | Hecha y probada |
| Base de datos y aislamiento entre negocios | Hecha y probada en Postgres real (en memoria) |
| Flujo de n8n | Probado en un **n8n 2.43.4 real**: 13 escenarios de punta a punta (ver abajo) |
| CLI de alta (Supabase, Meta, n8n) | Hecha y probada contra servidores simulados |
| Cuenta de Meta, número, token, Supabase real, tu n8n | **Falta**: ver `PASOS-DAVID.md` |

## Cosas que hay que saber

- **Cloud API oficial** (no WhatsApp Web ni Evolution): no hay riesgo de baneo por automatizar, pero Meta exige verificar el negocio y aprobar plantillas.
- **Ventana de 24 h**: el bot responde libremente a quien le escribe. Los avisos al dueño salen como *plantilla* (`aviso_escalamiento`, `nueva_solicitud_reserva`), que Meta debe aprobar primero.
- **Precios de Meta y de Claude**: revisarlos antes de cobrar a un cliente; cambian.
- **Versión de la Graph API**: `v23.0` en `bot.cjs` y `cli.mjs`. Verificar la vigente.
- **Seguridad del flujo**: se valida la firma `X-Hub-Signature-256` de cada mensaje con el secreto de la app. El contexto lleva el token del canal; en n8n conviene `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`.
- Los tokens de los canales viven en la tabla `canales`, que ninguna política deja leer a usuarios. Para más protección, moverlos a Supabase Vault.

## Prueba de punta a punta (n8n real)

`tests/e2e-n8n.mjs` levanta un n8n de verdad (requiere **Node 24**), un Postgres en memoria con el esquema real (hace de Supabase) y un "Meta" y un "Anthropic" simulados. Instala el flujo con el mismo comando de producción (`cli.mjs n8n --enviar`) y le manda webhooks firmados. Verifica:

dos clientes a la vez (un hotel en México en español y uno en EE. UU. en inglés, con fecha mes/día, respuesta traducida y plantilla `en_US` al dueño) · verificación del webhook · firma falsa ignorada · saludo y tarifas · reserva de 5 pasos guardada con folio y aviso al dueño · escalamiento y silencio · IA acotada · "no sé" sin inventar · webhook repetido = 1 respuesta · fotos · aviso al dueño que falla · base que falla al guardar (no confirma) · credencial de Supabase correcta.

```bash
N8N_BIN=/ruta/a/node_modules/.bin/n8n npm run e2e
```
Lo que **no** cubre: Meta real, WhatsApp real y la API real de Claude. Eso se prueba con `tests/CHECKLIST-REAL.md` cuando exista el número.

## Fuentes sobre salud y WhatsApp
- Meta no ofrece BAA para WhatsApp y los recordatorios de citas con datos de pacientes se consideran riesgo HIPAA (resúmenes de terceros, no del documento de Meta): [Accountable](https://www.accountablehq.com/post/is-whatsapp-hipaa-compliant-best-practices-and-compliance-tips), [LuxSci](https://www.luxsci.com/blog/is-whatsapp-hipaa-compliant/).
- Política de mensajería de WhatsApp Business (restringe información de salud donde la ley exige protecciones especiales): [business.whatsapp.com/policy](https://business.whatsapp.com/policy).
- Esto no es asesoría legal. Antes de vender a un negocio de salud, consulta a un asesor de HIPAA.
