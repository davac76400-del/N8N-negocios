# Handoff: proyecto "Asistente de WhatsApp multi-cliente"

Documento para pegar en un chat nuevo. Con esto, el otro chat puede continuar sin haber visto nada de lo anterior.
Fecha de corte: 14 de octubre de 2026. Todo lo descrito está en la carpeta `whatsapp-bot/` (se adjunta como ZIP).

---

## 0. Instrucciones para el chat nuevo

- Habla en **español**, con **frases cortas** y **al grano**. Es la preferencia del usuario.
- El usuario es **David Alfredo Romero Rendón**, 25 años, trabaja en **Windows** con Claude, Claude Code, Cowork, n8n, Supabase, Cursor Pro y Python. Le apasiona crear proyectos de software con IA.
- Confía en Claude y quiere **automatizar todo lo posible**: que Claude ejecute los comandos y él solo haga lo que es imposible de automatizar (cuentas, verificaciones, pagos).
- **Este proyecto es independiente** del sitio de ArcoSodi (ver sección 14). No mezclar.
- **Reglas de trabajo acordadas:**
  - **Nunca** pedir ni aceptar claves, tokens o contraseñas pegados en el chat. Se guardan en el entorno de Claude Code (Network secrets / variables de entorno) con nombres acordados (sección 9).
  - Avisar **costos** antes de crear algo de pago (por ejemplo un proyecto de Supabase).
  - **No crear PR** ni subir a ramas sin que lo pida. En la sesión anterior, David dijo "súbelo si lo ves conveniente" y se subió a la rama `claude/stoic-lovelace-ubmi6w`. En un chat nuevo, preguntar primero.
  - Decir la verdad sobre lo que **no** se probó (sección 10).

---

## 1. La idea del negocio

David quiere tener un **producto listo para ofrecer a muchos negocios**: hoteles, restaurantes y negocios de citas (salón, barbería, taller, spa…), en **México y Estados Unidos**.

Flujo comercial que él imagina:
1. Le manda al negocio un **formulario** (en español o inglés).
2. El negocio lo llena con sus datos reales y **copia el texto** que genera.
3. David (o Claude) guarda ese texto como archivo, corre unos **comandos** y el **chatbot de WhatsApp queda listo**.
4. Claude ejecuta todo lo posible; David hace solo lo que requiere a una persona.

Frase de David: *"Ya tengo toda la estructura realizada literal solo para poner datos."*

**ArcoSodi Hotel Boutique** (hotel de su tía en Oaxaca) es solo el **primer cliente de prueba**. El bot se aplicará allí después, en otro momento.

---

## 2. Qué se construyó (todo en `whatsapp-bot/`)

| Archivo | Qué es |
|---|---|
| `README.md` | Visión general, diagrama, comandos, estado, fuentes |
| `PASOS-DAVID.md` | Paso a paso de lo que le toca a David (Meta, Supabase, n8n, claves) |
| `HANDOFF.md` | Este documento |
| `n8n/code/bot.cjs` | **Toda la lógica del bot** (480 líneas, funciones puras, español e inglés). Única fuente de verdad |
| `n8n/whatsapp-bot.workflow.json` | Flujo de n8n **generado** (27 nodos). No se edita a mano |
| `scripts/build-workflow.mjs` | Genera el flujo de n8n copiando `bot.cjs` dentro de los nodos Code |
| `scripts/cli.mjs` | CLI de alta: validar, SQL, aplicar a Supabase, plantillas de Meta, webhook de Meta, probar, desplegar en n8n |
| `scripts/build-formulario.mjs` | Inyecta `clientes/formulario.json` en la plantilla del formulario |
| `supabase/schema.sql` | Tablas, seguridad por filas (RLS), funciones `bot_*` y restricción de salud |
| `clientes/formulario.json` | Definición bilingüe del formulario (qué se pide a cada negocio) |
| `clientes/arcosodi.json` | Datos de ArcoSodi (faltan 3: ver sección 12) |
| `formulario/plantilla.html` y `formulario/index.html` | Formulario web bilingüe (la plantilla y la página completa) |
| `plantillas/plantillas.json` | 6 plantillas de WhatsApp para aprobación de Meta (3 en español `es_MX`, 3 en inglés `en_US`) |
| `tests/*.test.mjs` | 59 pruebas rápidas |
| `tests/e2e-n8n.mjs` | Prueba de punta a punta contra un **n8n real** |
| `tests/CHECKLIST-REAL.md` | Lista de pruebas con el número real de WhatsApp |
| `package.json` | Scripts: `npm test`, `npm run build`, `npm run e2e` |

Formulario publicado como Artifact (privado hasta que David lo comparta con el menú Share): https://claude.ai/artifact/JkFVQthpJWjqEAo4EJGuPL

Repositorio: `davac76400-del/varios`, rama `claude/stoic-lovelace-ubmi6w`. Commits del proyecto: `8c20fa5` (versión inicial) y `f4fae8b` (bilingüe + EE. UU.). Sin PR abierto.

---

## 3. Cómo funciona el bot

### 3.1 Recorrido de un mensaje

```
Cliente en WhatsApp ─▶ Meta (Cloud API oficial) ─▶ webhook de n8n
   1. ¿La firma X-Hub-Signature-256 es válida?  ── no ──▶ se ignora (no responde, no guarda)
   2. Supabase: guarda el mensaje, ignora duplicados, trae datos del negocio y su conversación
   3. ¿Hay una persona atendiendo (pausa)? ── sí ──▶ se guarda el mensaje y el bot calla
   4. Reglas en español e inglés ──(entiende)──▶ responde con el texto fijo del negocio
            │ (no entiende)
            └─▶ Claude Haiku: clasifica o contesta SOLO con datos del negocio
   5. Reserva: pregunta paso a paso ─▶ resumen ─▶ "SÍ/YES" ─▶ Supabase ─▶ solicitud con folio
   6. Queja / piden persona / 3 dudas sin resolver ─▶ aviso al dueño (plantilla) + el bot calla 30 min
   7. Pausa aleatoria de 3 a 10 s ─▶ responde por la Cloud API ─▶ queda en el historial
```

### 3.2 Reglas de negocio que el bot siempre respeta

1. **No inventa.** Tarifas, horarios, ubicación, servicios y políticas salen de lo que el negocio escribió. Si falta el dato: "Ese dato lo confirma una persona. Escribe 'persona'."
2. **La IA es el último recurso.** Primero reglas. Claude Haiku solo se llama cuando las reglas no entienden. Su respuesta se valida: JSON estricto, intención válida, máximo 400 caracteres y **no se aceptan enlaces que no estén en los datos del negocio**. El mensaje del cliente va entre `<mensaje>…</mensaje>` y se trata como dato, no como instrucción.
3. **Una reserva es una solicitud.** Nunca se dice "confirmada". Se dice "recibida, folio X, una persona te confirmará". Si Supabase no pudo guardarla, **no** dice "recibida": avisa a una persona.
4. **Escalamiento inmediato** a una persona cuando: piden hablar con alguien (cualquier redacción, en los dos idiomas), hay queja o urgencia (groserías, cobro doble, fraude, abogado, alergia, emergencia…) o el cliente manda **3 mensajes seguidos sin resolver**.
5. **Al escalar:** avisa al dueño por **plantilla** de WhatsApp, avisa al cliente que ya viene una persona y **pausa el bot en esa conversación** (`pausa_min`, 30 por defecto). Si el aviso al dueño falla, el cliente recibe una respuesta honesta ("intenté avisar pero hubo un problema").
6. **Webhooks repetidos** (Meta reenvía) producen **una sola** respuesta.
7. Mensajes que no son texto (foto, audio): pide que escriba.

### 3.3 Reservas y citas (llenado de datos)

Datos que pide según el giro:
- `hotel`: llegada, salida, personas, nombre.
- `restaurante`: fecha, hora, personas, nombre.
- `citas`: fecha, hora, servicio, nombre.

Entiende todo en un mensaje ("del 12 al 15 de noviembre para 2 personas a nombre de Ana") o paso a paso. Detalles:
- Fechas en español e inglés: "20 de noviembre", "Nov 20th", "from Nov 12 to Nov 15", "mañana/tomorrow", "20/11", "11/20", "3 noches/3 nights".
- **Formato por país:** en EE. UU. `3/4` es **4 de marzo** (mes/día); en México es 3 de abril. Si no cuadra como mes/día, lo lee como día/mes.
- "el viernes / this Friday" **no se adivina**: pide la fecha exacta.
- Una fecha que pasó hace menos de 60 días se avisa como "ya pasó" (en vez de moverla al año siguiente).
- Horas: "8:30 pm", "20:30", "3pm", "noon", "8 de la noche".
- Dudas a media solicitud ("¿tienen estacionamiento?") se contestan y se sigue donde iba.
- "cancelar/cancel" cancela. En el resumen, "SÍ/YES" envía y "NO" reinicia.
- La reserva se guarda como `pendiente` con folio de 6 caracteres. Si el cliente confirma dos veces seguidas, devuelve el mismo folio.

### 3.4 Idiomas

- Detecta el idioma de **cada conversación** por el texto del cliente. Un "2" o un nombre no lo cambian.
- Las intenciones se reconocen en **ambos idiomas a la vez** (sirve para espanglish).
- Las respuestas fijas del negocio se guardan por idioma. Si falta la del idioma del cliente, usa la otra.
- `aplicar --traducir` traduce las respuestas al otro idioma con Claude y **descarta** cualquier traducción donde cambien un número, precio, hora o enlace.
- El saludo personalizado solo se usa con quien escribe en el idioma del negocio.

---

## 4. Base de datos (Supabase)

Un solo proyecto para todos los negocios. Cada fila lleva `cliente_id`.

**Tablas:** `clientes`, `canales` (número de WhatsApp + token + secreto de la app; **ninguna política los expone**), `respuestas_fijas` (por clave e idioma), `conversaciones`, `mensajes`, `reservaciones`, `miembros` (usuarios del panel de cada negocio).

**Columnas relevantes de `clientes`:** `giro` (hotel | restaurante | citas), `pais` (MX | US | OTRO), `idioma` (es | en), `salud` (booleano), `zona_horaria`, `dueno_nombre`, `dueno_telefono`, `saludo`, `pausa_min`, `activo`.

**Funciones (solo `service_role`, o sea n8n):** `bot_canal`, `bot_contexto`, `bot_responder`, `bot_reservar`.

**Seguridad (probada en Postgres real en memoria):**
- RLS en todas las tablas; cada usuario solo ve su negocio; no puede escribir ni mover datos de otro.
- `anon` y `authenticated` no pueden ejecutar las funciones del bot ni leer `canales`.
- **Restricción `sin_salud_en_us`:** la base **se niega** a crear o actualizar un negocio con `pais = 'US'` y `salud = true`.

**Estado real:** **no existe todavía un proyecto de Supabase para esto.** En la cuenta de David solo hay uno, **OaxIntegra-IA**, que está pausado y es de **otro negocio**: **no tocarlo**. Crear uno nuevo puede costar dinero: decisión pendiente de David.

---

## 5. n8n

### 5.1 El flujo (27 nodos, generado por `build-workflow.mjs`)

Verificación de Meta: `Meta verifica (GET)` → `¿Token correcto?` → `Devolver desafío` / `Rechazar` (403).
Mensajes: `Meta envía (POST)` (responde 200 de inmediato, guarda el cuerpo crudo) → `Parsear` → `Canal` → `Firma` → `¿Firma válida?` → `Contexto` → `¿Contesta el bot?` → `Decidir` → `¿Necesita IA?` → (`Preparar IA` → `Claude (solo si hace falta)` → `Leer IA`) → `¿Confirmó la reserva?` → (`Guardar reserva` → `Cerrar reserva`) → `Preparar envío` → `¿Avisar a una persona?` → `Avisar a una persona` → `Armar mensaje` → `Pausa humana (3-10 s)` → `Enviar al cliente` → `Guardar respuesta`. Más una nota (`Leeme`).

Notas técnicas:
- Los nodos de Supabase son **HTTP Request** a `/rest/v1/rpc/<función>` con credencial **Custom Auth** (headers `apikey` y `Authorization: Bearer <service_role>`).
- La IA es un HTTP Request a la API de Anthropic con credencial **Header Auth** (`x-api-key`). Modelo por defecto `claude-haiku-5-5`.
- La firma de Meta se valida con un **SHA-256/HMAC escrito a mano** dentro del Code node (no depende de módulos de Node). Probado contra el de Node en 11 largos distintos.
- Tienen `retryOnFail` y `onError: continueRegularOutput` donde corresponde (envío, aviso, guardar reserva).
- **Un solo flujo atiende a todos los clientes:** busca al negocio por el `phone_number_id` que trae el webhook.
- Recomendado en n8n: `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` (el contexto lleva el token del canal).

### 5.2 Cómo se instala

`node scripts/cli.mjs n8n --enviar` crea las 2 credenciales por la API de n8n, genera el flujo con un **token de verificación** y una **ruta de webhook aleatoria**, lo importa y lo activa. Imprime la URL del webhook y el token (se pegan en Meta).

Requiere: `N8N_URL` (https público), `N8N_API_KEY` (n8n → Settings → n8n API), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ANTHROPIC_API_KEY`.

### 5.3 Qué se probó con un n8n real

n8n **2.43.4** instalado desde npm y ejecutado con **Node 24** (n8n 2.x no corre con Node 22). El CLI creó credenciales y flujo contra ese n8n, el flujo se activó y atendió webhooks firmados. Detalles en la sección 10.

Hallazgos: el webhook tarda ~1–2 s en registrarse tras activar; n8n 2.x necesita `N8N_LISTEN_ADDRESS=127.0.0.1` si no hay IPv6; las llaves de API de n8n se crean con los scopes `workflow:create/update/read/list/activate` y `credential:create`.

### 5.4 Lo que **no** se sabe

- **Dónde corre el n8n de David** ni su versión. Pendiente de preguntar. Para que Meta le hable necesita **https público** (n8n Cloud, VPS, o túnel como Cloudflare Tunnel si está en su PC).
- No se ha instalado nada en su n8n real.

---

## 6. Meta / WhatsApp

### 6.1 Decisión técnica

Se usa la **WhatsApp Business Cloud API oficial de Meta**, **no** WhatsApp Web ni Evolution API. Motivo: Evolution opera sobre WhatsApp Web y Meta puede banear el número. Con la API oficial no hay ese riesgo, pero Meta exige verificar el negocio y aprobar plantillas.

### 6.2 Lo que David debe hacer (no se puede automatizar)

1. Cuenta en business.facebook.com con el negocio del cliente.
2. **Verificación del negocio** (documentos). Puede tardar días: empezar primero.
3. developers.facebook.com → crear app tipo **Business** → agregar producto **WhatsApp**.
4. Agregar el **número del bot**: debe ser un número que **no** esté activo en la app normal de WhatsApp (si es el del hotel, hay que borrarlo de la app primero).
5. Agregar un **método de pago**.
6. Business Settings → Usuarios del sistema → crear uno con rol Admin → **generar token** con permisos `whatsapp_business_management` y `whatsapp_business_messaging`, sin vencimiento.
7. Anotar: `META_TOKEN`, `META_WABA_ID`, `META_PHONE_NUMBER_ID`, `META_APP_ID`, `META_APP_SECRET`.

**Cada cliente necesita su propia cuenta de WhatsApp Business** (su verificación, su número, su pago). Un número por cliente, nunca compartido. David entra como administrador o con un usuario del sistema.

### 6.3 Lo que Claude automatiza (con el CLI)

- `plantillas [--idioma=es|en] --enviar`: manda las plantillas a aprobación (omite las que ya existen).
- `plantillas --estado`: lista cada plantilla con su estado y **motivo de rechazo**, para corregir y reenviar.
- `webhook-meta --enviar`: registra el webhook (`callback_url` + `verify_token`, campo `messages`) y suscribe la app a la cuenta de WhatsApp Business.
- `probar <número> --enviar`: manda `hello_world` para comprobar el canal.

### 6.4 Plantillas (categoría UTILITY)

Necesarias porque los avisos al **dueño** son mensajes iniciados por el negocio (fuera de la ventana de 24 h, solo se pueden mandar plantillas aprobadas). Las respuestas a clientes que escriben sí van como texto libre.

| Nombre | Idioma | Uso |
|---|---|---|
| `aviso_escalamiento` / `_en` | es_MX / en_US | Avisa al dueño que alguien necesita una persona (nombre, teléfono, motivo) |
| `nueva_solicitud_reserva` / `_en` | es_MX / en_US | Avisa al dueño de una nueva solicitud (folio, nombre, datos) |
| `confirmacion_reserva` / `_en` | es_MX / en_US | Para que el negocio confirme después (aún no la usa el flujo) |

Nada está enviado a Meta todavía. Meta puede rechazar plantillas; el procedimiento es `--estado`, corregir el texto en `plantillas/plantillas.json` y reenviar.

### 6.5 El MCP oficial de Meta (lo que dijo Gemini)

Se verificó con búsqueda web (solo noticias, **no** la documentación de Meta): el **WhatsApp Business Tools MCP** salió el **15 de septiembre de 2026**, está en **beta** y se activa gradualmente. Un agente (Claude, Cursor, Codex…) puede, con la cuenta de Meta de la persona: crear la cuenta de WhatsApp Business, agregar y verificar el número y registrarlo en la Cloud API, revisar términos, pagos y verificación del negocio, redactar y editar plantillas, y probar mensajes y webhooks. Meta tiene además un "Meta Social Technologies MCP" para documentación y diagnóstico.

Límites: el usuario debe **iniciar sesión con su cuenta de Meta y elegir qué negocios puede tocar el agente**; **no elimina** identidad, verificación ni políticas. Se conecta desde el **Claude Code de David en Windows**, no desde la sesión en la nube. **Pendiente:** leer la documentación oficial de Meta para el nombre exacto, el comando de conexión y la lista de herramientas.

Fuentes: [TechCrunch](https://techcrunch.com/2026/09/15/meta-now-lets-ai-agents-handle-the-boring-parts-of-whatsapp-business-setup/), [remio.ai](https://www.remio.ai/post/meta-whatsapp-business-mcp-moves-setup-into-ai-agents-but-approval-still-matters), [ProPakistani](https://propakistani.pk/2026/09/16/meta-lets-ai-agents-set-up-whatsapp-business-for-you/). Evitar los "MCP de WhatsApp" **no oficiales** que usan WhatsApp Web: pueden banear el número ([DragApp](https://www.dragapp.com/blog/whatsapp-mcp-server/)).

### 6.6 Por verificar

- Versión de la Graph API: el código usa **`v23.0`** (`bot.cjs` y `cli.mjs`). Confirmar la vigente.
- Precios de Meta (conversaciones y mensajes de plantilla) y de Claude Haiku: revisarlos antes de cotizar.
- El nombre del modelo `claude-haiku-5-5` se tomó del entorno de Claude Code; confirmar en la consola de Anthropic.

---

## 7. El formulario

Página estática bilingüe (español/inglés, por defecto el idioma del navegador; el cambio conserva lo escrito). **Nada se envía desde la página**: el negocio **copia el texto** y se lo manda a David. Guarda un borrador en el navegador.

Campos (13 obligatorios): nombre del negocio, tipo (hotel | restaurante | citas), país (US | MX | otro), idioma en que escribe sus respuestas, **¿maneja información de salud?**, ciudad, dirección, zona horaria (lista de EE. UU. y México), número de WhatsApp del asistente, quién recibe los avisos y su WhatsApp, correo, respuestas fijas (tarifas, horarios, ubicación, servicios, políticas), saludo y minutos de pausa.

Limpia los teléfonos (`+1 (555) 123-4567` → `15551234567`). La salida es un JSON que `cli.mjs validar` acepta (probado de ida y vuelta en navegador). Si eligen EE. UU. + salud = Sí, muestra un aviso y aun así permite enviar para ofrecer otra vía.

Nota técnica: los Artifacts no permiten descargas, por eso se usa "copiar". El archivo `formulario/index.html` se puede subir a cualquier hosting estático (por ejemplo Vercel) y funciona igual.

---

## 8. Dentistas y clínicas en EE. UU. (decisión importante)

**No conectar a WhatsApp.** Hallazgos (fuentes secundarias, no el documento de Meta):
- Meta **no firma BAA** (acuerdo de HIPAA) para WhatsApp; incluso confirmar citas con datos de pacientes se considera riesgo. [Accountable](https://www.accountablehq.com/post/is-whatsapp-hipaa-compliant-best-practices-and-compliance-tips), [LuxSci](https://www.luxsci.com/blog/is-whatsapp-hipaa-compliant/).
- La política de WhatsApp Business restringe enviar o pedir información de salud donde la ley exige protecciones especiales: [business.whatsapp.com/policy](https://business.whatsapp.com/policy). Violarla puede suspender la cuenta.

**Cómo se implementó el freno (tres capas):** el formulario pregunta; `cli.mjs validar` devuelve **BLOQUEADO**; y la **base de datos** rechaza el negocio (`sin_salud_en_us`). Fuera de EE. UU. (p. ej. México) se permite **con avisos**: consentimiento expreso, no guardar datos clínicos; el saludo pide no compartir información médica.

**Alternativa a explorar:** el mismo bot por **SMS** con un proveedor que firme BAA, más un asesor de HIPAA. Es otro canal; la lógica de `bot.cjs` se reutiliza. No está construido. Esto no es asesoría legal.

**Mercado:** en EE. UU. domina el SMS; WhatsApp se usa sobre todo en comunidades hispanas y viajeros. Validar con cada negocio que sus clientes usan WhatsApp antes de venderlo.

---

## 9. Comandos y variables de entorno

Sin `--enviar` todo es **ensayo** (muestra qué haría y no toca nada). Los secretos se leen del entorno y **nunca se imprimen**.

```bash
npm install
npm test                                                              # 59 pruebas, unos segundos
node scripts/cli.mjs validar clientes/<negocio>.json                  # revisa faltantes, bloqueos y avisos
node scripts/cli.mjs sql clientes/<negocio>.json                      # SQL de alta, sin secretos
node scripts/cli.mjs aplicar clientes/<negocio>.json --traducir --enviar   # Supabase (+ traducción)
node scripts/cli.mjs plantillas --idioma=en --enviar                  # Meta: plantillas (es o en)
node scripts/cli.mjs plantillas --estado                              # aprobadas/rechazadas y por qué
node scripts/cli.mjs n8n --enviar                                     # credenciales + flujo + activar
node scripts/cli.mjs webhook-meta --enviar                            # registra el webhook en Meta
node scripts/cli.mjs probar <número> --enviar                         # hello_world
npm run build                                                         # regenera n8n/whatsapp-bot.workflow.json
N8N_BIN=/ruta/n8n npm run e2e                                         # prueba con n8n real (Node 24)
```

**Orden de alta de un cliente nuevo:** `validar` → `aplicar --traducir --enviar` → `plantillas --idioma=… --enviar` (una vez por cuenta de Meta) → `n8n --enviar` (una vez en total) → `webhook-meta --enviar` → `probar` → checklist con el número real.

| Variable | Origen |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase → Settings → API (`service_role`, secreta) |
| `N8N_URL`, `N8N_API_KEY` | URL https de n8n; n8n → Settings → n8n API |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `META_TOKEN`, `META_WABA_ID`, `META_PHONE_NUMBER_ID`, `META_APP_ID`, `META_APP_SECRET` | Meta (sección 6.2) |
| `WA_VERIFY_TOKEN`, `WEBHOOK_PATH`, `WEBHOOK_URL` | Los genera/imprime `n8n --enviar` |
| `MODELO_IA`, `GRAPH_BASE` | Opcionales. `GRAPH_ORIGIN`, `ANTHROPIC_URL`, `ESPERA_MIN/MAX` solo para pruebas |

**Cómo pasar las claves a Claude (sesión en la nube):** menú del entorno (título de la sesión) → **Edit** → **Network secrets** (o variable de entorno) con esos nombres; en **Network access** permitir `graph.facebook.com`, `api.anthropic.com`, `*.supabase.co` y el dominio de n8n. Abrir una **sesión nueva**: ahí ya ve las variables. Nunca pegarlas en el chat.

---

## 10. Pruebas: qué se probó y qué no

**59 pruebas rápidas (`npm test`):**
- Lógica del bot (español e inglés): fechas, horas, reserva paso a paso y en un mensaje, fecha ambigua y pasada, cancelar, dudas a media solicitud, escalamiento, IA validada, idioma, formato por país, giro "citas", webhook de Meta, firma y SHA-256/HMAC propio.
- Base de datos en Postgres real en memoria (PGlite): aislamiento entre negocios, secretos, permisos de funciones, duplicados, pausa, reserva idempotente, restricción de salud.
- CLI contra servidores simulados: Supabase, Meta, n8n, traducción; verifica que **ningún secreto se imprime**.
- Estructura del flujo de n8n: nombres únicos, conexiones válidas, nodos alcanzables, código compilable.

**Prueba de punta a punta con n8n real (`tests/e2e-n8n.mjs`, 17 comprobaciones):** levanta n8n 2.43.4, Postgres en memoria con el esquema real, un "Meta" y un "Anthropic" simulados; instala el flujo con el comando de producción y manda webhooks firmados. Verifica: verificación GET, token malo → 403, firma falsa ignorada, saludo/menú, tarifas desde la base, canal y token correctos, reserva de 5 pasos guardada con folio + aviso al dueño por plantilla, escalamiento + silencio, IA acotada, "no sé" sin inventar, webhook repetido = 1 respuesta, foto, aviso al dueño que falla, **base que falla al guardar (no confirma)**, **segundo cliente en EE. UU. en inglés** (fecha mes/día, respuesta traducida, plantilla `en_US`), credencial de Supabase correcta.

**NO probado (sin cuentas reales):** Meta real, WhatsApp real, la API real de Claude, un Supabase real en la nube, el n8n de David, el MCP oficial de Meta, las plantillas aprobadas por Meta, costos reales. Eso se prueba con el número real (`tests/CHECKLIST-REAL.md`).

---

## 11. Riesgos y límites conocidos

- **Salud en EE. UU.** (sección 8).
- **Costos:** Meta cobra mensajes/plantillas; Claude Haiku (centavos por mensaje que las reglas no entienden); Supabase y n8n. Cotizar con precios vigentes.
- **Tokens de canales** viven en la tabla `canales` (sin política de lectura). Mejora futura: Supabase Vault.
- **El contexto que pasa por n8n incluye el token del canal**; por eso se recomienda no guardar ejecuciones exitosas.
- **Disponibilidad real:** el bot **no** revisa si hay cuartos o mesas libres; toda reserva es una solicitud `pendiente` que una persona confirma.
- **Precisión de lenguaje:** las reglas cubren casos comunes; lo raro va a la IA o a una persona. Hay que revisar conversaciones reales los primeros días.
- **Número de WhatsApp:** debe ser uno que no esté en la app normal.
- **Verificación de negocio y plantillas** dependen de Meta (tiempos y rechazos fuera de nuestro control).

---

## 12. Estado y pendientes

**Hecho:** lógica, base de datos, flujo n8n, CLI, formulario, plantillas, pruebas, documentación, subido a la rama.

**Pendiente (David):**
1. **Meta:** verificar negocio, número, pago, token (sección 6.2). Es lo más lento.
2. **Supabase:** decidir si se crea un proyecto nuevo (costo).
3. **n8n:** decir dónde corre su n8n y si tiene https público; crear la llave de API.
4. **Claves** en el entorno de Claude Code (sección 9).
5. **Datos de ArcoSodi** que faltan para `validar`: número del bot (`telefono_bot`), quién recibe los avisos (`dueno_nombre`, probablemente su tía) y los horarios de check-in/check-out (`resp_horarios`). También conviene políticas y confirmar que `529511607980` es el WhatsApp que recibe los avisos.
6. Compartir el formulario (menú Share del Artifact) o subir `formulario/index.html` a un hosting.
7. Cambiar la contraseña del panel de ArcoSodi (`97867` apareció en el chat).

**Pendiente (Claude), cuando existan las claves:** ejecutar el orden de la sección 9, revisar `plantillas --estado` y corregir rechazos, y recorrer el checklist con el número real.

**Ideas futuras (no construidas):** panel para que cada negocio vea conversaciones y confirme reservas; canal SMS con BAA para clínicas; cancelar/cambiar reservas; revisar disponibilidad real (ArcoSodi ya tiene disponibilidad en vivo en su sitio, pero el bot no la lee); confirmar reservas desde el WhatsApp del dueño; alta autoservicio con Embedded Signup de Meta; flujo de errores/alertas en n8n; facturación.

---

## 13. Decisiones que ya se tomaron (para no re-discutir)

- API oficial de Meta, no Evolution/WhatsApp Web.
- Reglas primero, IA solo de respaldo y acotada.
- Reserva = solicitud con folio; nunca "confirmada" por el bot.
- Un solo flujo de n8n para todos los clientes; lógica en un único archivo probado.
- Bilingüe por conversación; respuestas del negocio traducidas con control de números y enlaces.
- Negocios de salud en EE. UU.: bloqueados en tres capas.
- Secretos solo por variables de entorno; nunca en el chat ni en archivos.
- Nada de alta automática en cuentas de terceros sin que la persona inicie sesión (Meta lo exige).

---

## 14. Contexto de ArcoSodi (solo referencia; proyecto aparte)

- **ArcoSodi Hotel Boutique:** hotel de 10 habitaciones en una casona de 300+ años, Oaxaca. Primer proyecto de pago / caso de estudio de David.
- **Sitio:** carpeta `arcosodi/` del mismo repo (HTML + módulos ES, 22 idiomas, panel de administrador con contraseña + correo, eventos con fotos y traducción automática, disponibilidad en vivo, formulario de reserva que manda a WhatsApp `+52 951 160 7980`). Vista previa publicada como Artifact: https://claude.ai/artifact/3N7jV849a3KieTsjQUrrkT (v13).
- **Cómo se conectará el bot después:** `clientes/arcosodi.json` ya tiene sus datos reales (tarifas, dirección, servicios). Faltan los 3 datos de la sección 12. Los textos de tarifas salen del sitio: habitaciones de $3,400, $4,200 y $5,900 MXN por noche con desayuno incluido.
- Hay un `arcosodi/HANDOFF.md` aparte con su documentación.

---

## 15. Arranque rápido para el chat nuevo

1. Pide a David el **ZIP** `whatsapp-bot` (o el repo `davac76400-del/varios`, rama `claude/stoic-lovelace-ubmi6w`, carpeta `whatsapp-bot/`).
2. `cd whatsapp-bot && npm install && npm test` → deben pasar 59.
3. Preguntas que conviene hacerle primero: ¿dónde corre tu n8n? ¿qué versión y tiene https público? ¿creamos un proyecto nuevo de Supabase? ¿ya empezaste la verificación del negocio en Meta? ¿quién recibe los avisos de ArcoSodi y cuáles son sus horarios?
4. Para hablar de n8n: leer sección 5 y `scripts/build-workflow.mjs`. Para Meta: sección 6 y `plantillas/plantillas.json`.
