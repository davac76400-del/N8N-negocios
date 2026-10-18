# Guía de despliegue a costo $0

Stack: **Render** (servidor) + **Supabase** (base de datos) + **Groq** (IA) + **Meta WhatsApp Cloud API** (WhatsApp) + **cron-job.org** (mantener despierto el servidor).
Orden: Supabase → Groq → Meta → Render → webhook → ping → prueba.

> Los planes gratuitos cambian. Antes de empezar revisa las páginas de precios de Render, Supabase, Groq y Meta. Las cifras de abajo salen de búsquedas, no de las páginas oficiales (no pude abrirlas desde mi entorno).

## 0. Qué es gratis y qué no

| Pieza | Gratis | Límite que te va a afectar |
|---|---|---|
| Render (web) | Sí, plan *Free* | Se duerme tras 15 min sin tráfico y tarda hasta ~1 min en despertar. 750 horas al mes por cuenta: alcanza para **un** servicio encendido 24/7. |
| Supabase | Sí, plan *Free* | Pausa el proyecto tras 1 semana sin actividad. 500 MB. **Sin respaldos automáticos.** |
| Groq | Sí, sin pago | Del orden de 30 peticiones por minuto y ~1 000 al día para Llama 3.3 70B, más un tope de tokens por minuto. Es **el total de todos tus clientes juntos**. Confírmalo en la consola de Groq. |
| Meta Cloud API | Hay una bolsa mensual gratis (~1 000 conversaciones de servicio) | **Ojo:** Meta cambió su cobro de mensajes de servicio. Pasada la bolsa, se cobra por mensaje. Revisa la página de precios de WhatsApp Business Platform. |
| Número de pruebas de Meta | Sí | Solo escribe a unos pocos destinatarios que tú verificas. Sirve para probar, **no** para atender clientes reales. |

Para atender clientes reales necesitas registrar el número del negocio en Meta (el registro no cuesta, pero el número sí debe existir y no estar activo en la app de WhatsApp).

## 1. Supabase (≈ 5 min)

1. supabase.com → *New project* (plan Free). Anota la contraseña de la base.
2. *SQL Editor* → pega y ejecuta `db/001_esquema.sql`.
3. *Connect* → **Session pooler** (puerto 5432) → copia la cadena; reemplaza `[YOUR-PASSWORD]`. Será `DATABASE_URL`. (Usa el pooler, no la conexión directa: la directa es IPv6.)

## 2. Groq (≈ 2 min)

console.groq.com → crea cuenta → *API Keys* → *Create API Key* → copia la clave (`LLM_API_KEY`). El modelo por defecto es `llama-3.3-70b-versatile`; si Groq lo retira, cambia `LLM_MODEL` por otro de su lista.

## 3. Meta (≈ 20 min)

1. developers.facebook.com → *My Apps → Create App* → tipo **Business** → agrega el producto **WhatsApp**.
2. *WhatsApp → API Setup*: ahí están el número de pruebas y su **Phone number ID**. En *To* agrega y verifica tu propio WhatsApp como destinatario.
3. *App settings → Basic* → **App Secret** (`WA_APP_SECRET`).
4. **Token permanente** (el temporal caduca en 24 h): Business Settings → *Users → System users* → crea uno (Admin) → asígnale tu app y la cuenta de WhatsApp → *Generate token* con permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WA_ACCESS_TOKEN`.
5. Inventa un `WA_VERIFY_TOKEN` (una frase larga al azar). Lo usarás en dos sitios.

## 4. Render (≈ 10 min)

> Puedes desplegar **antes** de tener Meta: `WA_*` son opcionales al arrancar. Sin ellas, el formulario y el panel funcionan y el webhook responde 503 hasta que las pongas. Cuando tengas Meta, agrégalas en *Environment* y Render redespliega.

1. render.com → crea cuenta con GitHub.
2. *New → Blueprint* → elige el repo `N8N-negocios` y la rama `claude/bots-whatsapp-ecosistema` (o `main` cuando la fusiones). Render lee `render.yaml`.
3. Te pide las variables secretas. **Llénalas todas**, si falta una el servicio no arranca (el log dice cuál):
   - Obligatorias: `DATABASE_URL`, `ADMIN_PASSWORD` (12+ caracteres), `LLM_API_KEY`.
   - Después, cuando tengas Meta: `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `WA_ACCESS_TOKEN`.
4. Espera el primer despliegue. Tu URL será `https://bots-whatsapp-xxxx.onrender.com`. Comprueba: abre `/health` → `{"ok":true}`.

## 5. Conectar el webhook en Meta

*WhatsApp → Configuration → Webhook → Edit*:
- Callback URL: `https://TU-URL.onrender.com/webhook/whatsapp`
- Verify token: tu `WA_VERIFY_TOKEN`
- *Verify and save* y, en *Webhook fields*, suscríbete a **messages**.

## 6. Mantenerlo despierto (gratis)

Render duerme el servicio a los 15 min. Para que el primer mensaje del día no espere ~1 min:

1. cron-job.org → cuenta gratis → *Create cronjob*.
2. URL `https://TU-URL.onrender.com/health`, ejecutar cada **10 minutos**.

`/health` también consulta la base, así que evita que Supabase se pause por inactividad. Un solo servicio 24/7 usa ~720 de las 750 horas; no despliegues un segundo servicio gratis en la misma cuenta.

Sin este ping funciona igual, pero el primer mensaje tarda y Meta puede reintentar la entrega.

## 7. Prueba de punta a punta

1. `https://TU-URL.onrender.com/` → llena un negocio de prueba con catálogo.
2. `https://TU-URL.onrender.com/admin` (usuario `admin` y tu `ADMIN_PASSWORD`) → abre la solicitud → pega el *Phone number ID* → **Aprobar**.
3. Desde tu WhatsApp (el que verificaste) escribe al número de pruebas: "¿qué tienen y cuánto cuesta?".
4. Prueba "quiero hablar con una persona": el bot debe callar y aparecer en *Escalaciones*.
5. Si algo falla: Render → *Logs*.

## 8. Operación sin gastar

- **Respaldos:** Supabase Free no respalda. Cada semana, desde tu computadora con `pg_dump` instalado: `DATABASE_URL="..." ./scripts/backup.sh`. Guarda el archivo fuera de tu máquina (Google Drive).
- **Cuidar el cupo de Groq:** catálogos largos gastan tokens en cada mensaje. Mantén cada catálogo corto. Si ves errores 429 en los logs, te pasaste del límite: el bot avisa al cliente y escala a una persona.
- **Apagar un bot:** panel → Clientes → borra el número y guarda.
- **Actualizar:** `git push` a la rama; Render redespliega solo.
- **Retención de datos:** programa `delete from mensajes where creado_en < now() - interval '12 months';` cuando crezca la base.

## 9. Cuándo dejará de ser gratis

Señales de que necesitas pagar algo: más de ~1 000 mensajes al día (Groq), más de 1 000 conversaciones al mes (Meta), base cerca de 500 MB (Supabase), o necesitas que el bot nunca tarde en despertar (Render de pago). El código no cambia: solo el plan.

## Alternativa de pago: VPS

`docker-compose.yml` + `Caddyfile` sirven para un VPS con HTTPS automático (`docker compose up -d --build`, con `DOMINIO` en `.env`). No hace falta en Render.

## Integrar con n8n (opcional)

Pon en `EVENTS_WEBHOOK_URL` un webhook de n8n. Recibirás un POST JSON con cabecera `X-Signature: sha256=<HMAC-SHA256 del cuerpo con EVENTS_WEBHOOK_SECRET>`:

```json
{"evento": "solicitud.aprobada", "solicitud_id": "…", "cliente_id": "…", "datos": {…cuestionario…}, "prompt_sistema": "…"}
{"evento": "conversacion.escalada", "cliente": "Tacos Don Beto", "telefono": "52951…", "nombre": "Ana", "motivo": "…", "resumen": "…"}
```
