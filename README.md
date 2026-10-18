# Ecosistema de bots de WhatsApp: formulario → aprobación → bot en producción

Un cliente llena un formulario, tú aprietas **Aprobar**, y su bot de WhatsApp queda atendiendo. Sin programar nada por cliente.

```
Cliente ──► Formulario web (/) ──► POST /api/solicitudes ──► Postgres (solicitudes)
                                                                  │
Tú ──► Panel (/admin): revisas ──► [Aprobar] ─ una transacción ──┤
                                      │                           ▼
                                      │              clientes (+ prompt generado + nº WhatsApp)
                                      └─► evento firmado "solicitud.aprobada" (n8n, opcional)

Cliente final ──► WhatsApp ──► Meta Cloud API ──► POST /webhook/whatsapp (firma HMAC)
                                                      │ responde 200 al instante
                                                      ▼
                          bot: ¿pausado? ¿duplicado? ¿tema sensible? ──► Claude (prompt del negocio)
                                                      │                        │ tool: pasar_a_humano
                                                      ▼                        ▼
                                  Meta Cloud API (respuesta)        pausa 30 min + alerta + panel
```

## Stack y por qué

| Pieza | Elección | Razón |
|---|---|---|
| WhatsApp | **API oficial de Meta (Cloud API)** | No tiene sesiones: ni QR, ni socket, ni archivos de sesión que se pierdan en un contenedor efímero. Solo token + webhook firmado. Sin riesgo de baneo por automatizar WhatsApp Web. |
| Backend | **Python + FastAPI**, un solo servicio | Formulario, panel, webhook y bot en un proceso: un único punto a monitorear. Validación con pydantic. |
| Base de datos | **Supabase Postgres** (conexión directa con asyncpg) | Persistencia real y respaldos gestionados. RLS activo como segunda barrera. Todo el estado vive aquí: el servidor es desechable. |
| IA | **Claude** (`pasar_a_humano` como herramienta, prompt cacheado) | El prompt del negocio se cachea; el modelo decide cuándo escalar. |
| HTTPS | **Caddy** | Certificados Let's Encrypt automáticos y renovados solos. |
| Hosting | **Docker en un VPS** (sirve cualquier host Docker) | Contenedor sin estado: si se reinicia, no se pierde nada. |

**Descartado a propósito**
- **Evolution API / Baileys:** simula WhatsApp Web. Requiere sesión persistente, reescanear QR si se cae y Meta puede banear el número. Contradice "cero pérdida de sesión".
- **n8n:** aquí no aporta; el flujo vive en el mismo proceso y n8n sumaría otro servicio con su propia base. Sigue siendo compatible: apunta `EVENTS_WEBHOOK_URL` a un webhook de n8n y recibe aprobaciones y escalaciones.
- **Vercel / serverless:** el webhook debe responder 200 y seguir trabajando; en serverless ese trabajo muere al responder.

**Un motor, N negocios.** "Construir el bot" de un cliente = generar su prompt a partir del cuestionario y vincular su número. No hay código ni despliegue por cliente: aprobar es inmediato.

## Estructura

```
app/
  main.py        rutas: formulario, panel (/admin), webhook de WhatsApp, /health
  models.py      cuestionario validado (límites de tamaño, honeypot)
  prompt.py      cuestionario → prompt del bot
  bot.py         motor conversacional: pausa, idempotencia, escalación, llamada a Claude
  whatsapp.py    firma de Meta, parseo del webhook, envío con reintentos
  events.py      eventos salientes firmados (opcional)
  db.py          todo el SQL; filtra por cliente_id
  config.py      variables de entorno (falla al arrancar si falta algo)
web/             index.html + form.js (cliente) · admin.html + admin.js (panel) · style.css
db/              001_esquema.sql (idempotente) · 001_down.sql
tests/           test_core.py (sin BD) · test_e2e.py (flujo completo con Postgres)
scripts/backup.sh
Dockerfile · docker-compose.yml · Caddyfile · .env.example
DESPLIEGUE.md    guía paso a paso
```

## Seguridad y estabilidad

- Webhook de Meta: se rechaza todo lo que no traiga firma HMAC válida. Meta reintenta entregas: `wa_message_id` único evita responder dos veces.
- Panel con usuario y clave (HTTPS + Basic). El contenido del formulario es público y hostil: el panel lo pinta solo como texto y hay CSP estricta (probado con un payload XSS).
- RLS activo en las 4 tablas sin políticas y permisos de `anon`/`authenticated` revocados: la clave pública de Supabase no lee nada.
- Si falla Claude o WhatsApp, el cliente recibe un aviso y la conversación se escala; nunca silencio.
- Tope de mensajes por hora y conversación contra abuso (costo de la API).

## Pruebas

```bash
python -m venv venv && . venv/bin/activate
pip install -r requirements.txt pytest
pytest                                              # sin base de datos
TEST_DATABASE_URL=postgresql://... pytest           # + flujo completo (BORRA el esquema de esa base)
```

## Límites conocidos

- **Alta del número en Meta es manual.** Automatizarla exige Embedded Signup (revisión de app de Meta). En el panel pegas el *Phone number ID* del cliente.
- **Atender a un humano ocurre fuera del bot.** El panel muestra teléfono, resumen y conversación; tú o el negocio contactan al cliente.
- Pedidos y reservas no se guardan como registros: el bot reúne los datos y escala con un resumen para que una persona confirme.
- Solo texto: audios e imágenes reciben un aviso.
- Si el contenedor muere justo mientras procesa un mensaje, ese mensaje queda sin respuesta (el cliente puede reenviar).
- Un solo worker de uvicorn (locks por conversación en memoria).

Siguiente paso: [DESPLIEGUE.md](DESPLIEGUE.md).
