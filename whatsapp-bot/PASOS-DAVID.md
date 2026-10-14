# Lo que toca hacer a David (y lo que hago yo)

Orden pensado para que no se te atore nada. Cada paso dice **quién** lo hace.

## 0. Cómo pasarme claves (sin pegarlas en el chat)

Tu confianza me importa, y por eso no te dejo pegar claves aquí: el chat se guarda y se puede copiar. Es más seguro y llega al mismo resultado.

1. En la sesión de Claude Code en la nube: menú del entorno (arriba, en el título) → **Edit**.
2. Pega cada clave en **Network secrets** (o como variable de entorno si esa sección no aparece), con **estos nombres exactos**:

| Variable | De dónde sale |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase → API → `service_role` (secreta) |
| `N8N_URL` | La dirección de tu n8n, con https |
| `N8N_API_KEY` | n8n → Settings → n8n API → Create key |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |
| `META_TOKEN` | Meta → usuario del sistema → token permanente (paso 2) |
| `META_WABA_ID` | Meta → WhatsApp → API Setup |
| `META_PHONE_NUMBER_ID` | Meta → WhatsApp → API Setup |
| `META_APP_ID` y `META_APP_SECRET` | Meta → App settings → Basic |

3. En **Network access**, agrega estos dominios: `graph.facebook.com`, `api.anthropic.com`, `*.supabase.co` y el dominio de tu n8n.
4. Abre una sesión nueva: ahí ya veo las variables.

Nunca me escribas una clave en el chat. Si ya lo hiciste con alguna (por ejemplo la contraseña `97867` del panel de ArcoSodi), cámbiala.

## 1. Supabase — decides tú

- El único proyecto que veo en tu cuenta es **OaxIntegra-IA**, está pausado y es de otro negocio. **No lo toco.**
- Crear uno nuevo (`bot-whatsapp`) puede costar dinero. Dime **"crea el proyecto"** y lo hago yo con la conexión de Supabase, o créalo tú en supabase.com (plan gratis sirve para empezar).
- Yo: aplico `supabase/schema.sql` y cargo al cliente. **Tú**: solo crear el proyecto y pasar las dos claves del paso 0.

## 2. Meta (WhatsApp Business) — esto es tuyo, no se puede automatizar

Meta pide a una persona real. Yo preparo todo lo demás.

1. Cuenta en business.facebook.com (con el negocio del cliente, en este caso ArcoSodi).
2. **Verificación del negocio** (documentos del hotel). Puede tardar días. Empieza ya.
3. developers.facebook.com → Crear app → tipo **Business** → agregar el producto **WhatsApp**.
4. Agregar el **número del bot**. Debe ser un número que **no** esté activo en la app de WhatsApp. Si es el del hotel, hay que borrarlo de la app primero.
5. Agregar un **método de pago** (Meta cobra por conversación; revisa la tabla de precios vigente).
6. Business Settings → Usuarios del sistema → crear uno con rol Admin → **Generar token** con permisos `whatsapp_business_management` y `whatsapp_business_messaging`, sin vencimiento. Ese es `META_TOKEN`.
7. Copiar `META_WABA_ID`, `META_PHONE_NUMBER_ID`, `META_APP_ID` y `META_APP_SECRET` al paso 0.

**Atajo con el MCP oficial de Meta (WhatsApp Business Tools MCP, en beta):** puede hacer los pasos 4–6 con un agente (verificar el número, revisar pagos y términos, probar el webhook, redactar plantillas). Se conecta desde **tu Claude Code en Windows**, no desde mi sesión en la nube, e inicias sesión con tu cuenta de Meta. Consulta en developers.facebook.com cómo agregarlo. Si te cuesta, el camino manual de arriba funciona igual.

## 3. n8n — dime cuál tienes

- Para que Meta le hable, tu n8n necesita una dirección **https pública**. Si corre en tu PC (localhost), hay dos salidas: n8n Cloud, o un túnel (Cloudflare Tunnel, gratis).
- En n8n: Settings → n8n API → crea una llave y pásala (paso 0). Yo creo las credenciales, importo el flujo y lo activo.

## 4. Lo que hago yo, en este orden

```bash
node scripts/cli.mjs validar clientes/arcosodi.json          # que no falte ningún dato
node scripts/cli.mjs aplicar clientes/arcosodi.json --enviar # Supabase
node scripts/cli.mjs plantillas --enviar                     # a aprobación de Meta
node scripts/cli.mjs plantillas --estado                     # si rechazan alguna, corrijo y reenvío
node scripts/cli.mjs n8n --enviar                            # imprime URL y token del webhook
node scripts/cli.mjs webhook-meta --enviar
node scripts/cli.mjs probar <tu número> --enviar
```
Después recorremos la lista de pruebas con el número real (en `tests/CHECKLIST-REAL.md`).

## 5. Datos de ArcoSodi que faltan (el bot no los inventa)

Ahora `validar` marca 3 faltantes en `clientes/arcosodi.json`:
- **Número de WhatsApp del bot** (`telefono_bot`).
- **Quién recibe los avisos** (`dueno_nombre`) — tu tía, ¿verdad?
- **Horarios** (`resp_horarios`): check-in, check-out y horario de atención.

También conviene llenar **políticas** (cancelación, mascotas, niños, pagos) y confirmar que el número `529511607980` es el que debe recibir los avisos.

## 6. Cuando tengas más clientes (hoteles, restaurantes, salones… en México o EE. UU.)

1. Mándales el formulario. Está en español e inglés (se elige arriba; por defecto sigue el idioma del navegador). Lo llenan y **copian el texto** que genera.
2. Pegas ese texto en un archivo `clientes/<negocio>.json`.
3. `validar` → `aplicar --traducir --enviar` (guarda y traduce las respuestas al otro idioma) → `plantillas --idioma=en --enviar` (o `es`).
4. Cada cliente necesita **su propia cuenta de WhatsApp Business en Meta** (su verificación de negocio, su número, su método de pago) y tú entras como administrador o con un usuario del sistema. **Un número por cliente**, nunca compartido.
5. Pruebas con el número real y entrega (`tests/CHECKLIST-REAL.md`).

**Dentistas y clínicas en EE. UU.:** el formulario los frena (pregunta si manejan información de salud) y la base de datos también. No los conectes a WhatsApp. Si te interesan, la vía es SMS con un proveedor que firme BAA: dime y adapto el canal.

**Qué le cobras:** el alta (una vez) y la mensualidad. Los costos que pagas tú o el cliente: mensajes de WhatsApp (Meta cobra por conversación/mensaje de plantilla, revisa la tabla vigente), Claude Haiku (centavos por cada mensaje que las reglas no entienden), Supabase y n8n.
