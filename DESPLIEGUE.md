# Guía de despliegue (≈ 1–2 horas)

Orden: base de datos → Meta → servidor → webhook → prueba. Cada paso termina con una comprobación.

## 1. Base de datos (Supabase)

1. Crea un **proyecto nuevo** en Supabase (separado de tus otros proyectos).
2. SQL Editor → pega y ejecuta `db/001_esquema.sql`.
3. Comprueba: *Database → Advisors* sin alertas de RLS. Las 4 tablas (`solicitudes`, `clientes`, `conversaciones`, `mensajes`) deben mostrar RLS activo.
4. *Connect* → **Session pooler** (puerto 5432) → copia la cadena en `DATABASE_URL` más adelante.

## 2. WhatsApp Cloud API (Meta)

1. developers.facebook.com → *My Apps → Create App* → tipo **Business** → agrega el producto **WhatsApp**.
2. *WhatsApp → API Setup*: ahí están el número de prueba y su **Phone number ID**. (El número de prueba solo escribe a hasta 5 destinatarios que verifiques.)
3. **App Secret**: *App settings → Basic* → `WA_APP_SECRET`.
4. **Token permanente** (el temporal caduca en 24 h): Business Settings → *Users → System users* → crea uno con rol Admin → asígnale tu app y la cuenta de WhatsApp → *Generate token* con permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WA_ACCESS_TOKEN`.
5. Para clientes reales: agrega el número del negocio (que no esté activo en la app de WhatsApp) y verifica el negocio en Business Manager; sin verificación Meta limita números y volumen.

## 3. Servidor (VPS con Ubuntu)

```bash
# Seguridad mínima
apt update && apt install -y ufw fail2ban unattended-upgrades
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
# En /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no (y usa un usuario normal con llaves)

# Docker
curl -fsSL https://get.docker.com | sh
```

DNS: crea un registro **A** `bots.tudominio.com → IP del VPS`.

```bash
git clone <este repo> /opt/bots && cd /opt/bots
git checkout claude/bots-whatsapp-ecosistema   # o main, una vez fusionado
cp .env.example .env && nano .env              # rellena TODO (secretos: openssl rand -hex 24)
docker compose up -d --build
```

Comprueba: `curl https://bots.tudominio.com/health` → `{"ok":true}` y `docker compose logs app` sin errores.
Si el contenedor no arranca, el log dice qué variable falta.

## 4. Conectar el webhook en Meta

*WhatsApp → Configuration → Webhook → Edit*:
- Callback URL: `https://bots.tudominio.com/webhook/whatsapp`
- Verify token: el mismo valor de `WA_VERIFY_TOKEN`
- *Verify and save*, luego en *Webhook fields* suscríbete a **messages**.

## 5. Prueba de punta a punta

1. Abre `https://bots.tudominio.com/` y llena un negocio de prueba con catálogo.
2. Abre `https://bots.tudominio.com/admin` (usuario y clave del `.env`). Revisa la solicitud, pega el *Phone number ID* y pulsa **Aprobar**.
3. Desde tu WhatsApp escribe al número de prueba: "¿qué tienen y cuánto cuesta?". Debe responder con tu catálogo.
4. Casos obligatorios antes de entregar a un cliente (con el número real):
   - reserva o pedido normal completo → termina escalando con resumen
   - fecha ambigua ("el viernes")
   - el cliente cambia de opinión a mitad
   - pregunta fuera de alcance (debe decir que no sabe, no inventar)
   - queja fuerte con groserías → escala
   - "quiero hablar con una persona" → escala y el bot calla; en *Escalaciones* aparece con resumen
   - dos conversaciones simultáneas desde números distintos
5. Si algo falla: `docker compose logs -f app`.

## 6. Operación

- **Monitoreo:** un monitor externo (UptimeRobot, BetterStack) sobre `https://bots.tudominio.com/health` con alerta a un canal que sí veas. Vigila también disco y memoria del VPS.
- **Respaldos:** Supabase respalda según tu plan; además programa el tuyo y súbelo **fuera del VPS**:
  ```bash
  # crontab -e   (diario 4:00)
  0 4 * * * cd /opt/bots && DATABASE_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-) ./scripts/backup.sh /var/respaldos
  ```
  Restaura una vez por trimestre en un servidor de prueba: es la única forma de saber que sirven.
- **Actualizar:** entre semana de 3 a 6 a.m.: `git pull && docker compose up -d --build`. No actualices en viernes ni en hora pico de los negocios.
- **Costo de IA:** fija un límite mensual en la consola de Anthropic. Para bajar el costo mucho, `CLAUDE_MODEL=claude-haiku-5-5` y `docker compose up -d`.
- **Apagar un bot:** panel → Clientes → borra el número y guarda.
- **Retención de datos:** define 12 meses en tu contrato y programa `delete from mensajes where creado_en < now() - interval '12 months';` (pg_cron de Supabase).
- **Rotar claves:** cambia el valor en `.env` y `docker compose up -d`.
- **Revertir el esquema:** `db/001_down.sql` (borra datos; respalda antes).

## 7. Integrar con n8n (opcional)

Pon en `EVENTS_WEBHOOK_URL` un webhook de n8n. Recibirás un POST JSON con cabecera `X-Signature: sha256=<HMAC-SHA256 del cuerpo con EVENTS_WEBHOOK_SECRET>`:

```json
{"evento": "solicitud.aprobada", "solicitud_id": "…", "cliente_id": "…", "datos": {…cuestionario…}, "prompt_sistema": "…"}
{"evento": "conversacion.escalada", "cliente": "Tacos Don Beto", "telefono": "52951…", "nombre": "Ana", "motivo": "…", "resumen": "…"}
```

Útil para avisar al dueño por Telegram o correo cuando hay una escalación.

## Alternativa sin VPS

La imagen no guarda estado: funciona en cualquier host de contenedores (Railway, Fly.io, Render) con **una instancia siempre encendida** y las mismas variables de entorno. Ahí el HTTPS lo pone la plataforma y puedes quitar Caddy.
