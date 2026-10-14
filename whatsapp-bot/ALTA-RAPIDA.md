# Alta rápida de un cliente nuevo

Meta: el negocio llena el formulario y Claude ejecuta todo lo demás.

## Qué es legal dónde

- **México:** hotel, restaurante y citas, sin problema. Salud: se permite con consentimiento expreso y sin datos clínicos en el chat.
- **Estados Unidos:** hotel, restaurante y citas, sin problema. **Salud: bloqueado.** WhatsApp no firma el acuerdo HIPAA. El formulario avisa, el CLI (`validar`) y la base de datos lo rechazan.
- Esto no es asesoría legal. Para clínicas, consulta a un asesor.

## Una sola vez (infraestructura propia)

1. **Supabase:** un proyecto. Aplicar `supabase/schema.sql`. Guardar `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`.
2. **n8n:** una instancia con https público. Crear llave de API. Guardar `N8N_URL` y `N8N_API_KEY`.
3. **Anthropic:** `ANTHROPIC_API_KEY`.
4. **Claves** en el menú del entorno de Claude Code (Network secrets). Nunca en el chat.
5. **Red permitida:** `graph.facebook.com`, `api.anthropic.com`, `*.supabase.co`, dominio de n8n.
6. `node scripts/cli.mjs n8n --enviar` → instala el flujo único. Imprime URL y token del webhook.
7. Subir `formulario/index.html` a un hosting (Vercel) para tener un enlace fijo.

## Qué te manda cada cliente

El formulario pide primero el **país**. Según el país muestra los estados y la lista de lo que debe preparar.

**Todos (México y EE. UU.):**
- Formulario lleno (copiado como texto).
- Cuenta de Meta Business con él como administrador.
- Verificación del negocio en Meta (tarda días: que empiece primero).
- Número solo para el asistente, libre en la app normal de WhatsApp, que reciba código por SMS o llamada.
- Método de pago en Meta.
- Acceso para configurar: administrador o usuario del sistema. Tokens por el entorno, nunca por chat.
- Logo, nombre legal, sitio web o red social.

**México, además:**
- Constancia de situación fiscal del SAT (RFC), o acta constitutiva si es persona moral.
- Comprobante de domicilio reciente con nombre y dirección del negocio.
- Aviso de privacidad publicado.

**Estados Unidos, además:**
- Carta del IRS con EIN (CP 575 o 147C), o artículos de constitución.
- Licencia de negocio estatal o local.
- Recibo de servicios o estado de cuenta con nombre legal y dirección.
- Privacy policy en su sitio.
- Solo se escribe a quien escribió primero o aceptó ser contactado (opt-in).
- Plantillas en inglés (`en_US`) y fechas mes/día.
- Verificar que sus clientes usen WhatsApp: en EE. UU. domina el SMS.

La lista es una guía. Meta puede pedir otros documentos.

## Lo que hace Claude por cada cliente

Con el texto guardado en `clientes/<negocio>.json`:

```bash
node scripts/cli.mjs validar clientes/<negocio>.json
node scripts/cli.mjs aplicar clientes/<negocio>.json --traducir --enviar
node scripts/cli.mjs plantillas --idioma=<es|en> --enviar
node scripts/cli.mjs plantillas --estado        # corregir rechazos y reenviar
node scripts/cli.mjs webhook-meta --enviar
node scripts/cli.mjs probar <numero> --enviar
```

Luego recorrer `tests/CHECKLIST-REAL.md` con el número real.

## Reglas

- Sin `--enviar` todo es ensayo.
- Cada cliente tiene su propia cuenta de Meta y su propio número.
- Los datos de clientes reales no se suben al repo si son privados.
