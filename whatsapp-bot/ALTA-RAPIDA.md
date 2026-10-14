# Alta rápida de un cliente nuevo

Meta: el negocio llena el formulario y Claude ejecuta todo lo demás.

## Una sola vez (infraestructura propia)

Se hace una vez y sirve para todos los clientes.

1. **Supabase:** un proyecto para el producto. Aplicar `supabase/schema.sql`. Guardar `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`.
2. **n8n:** una instancia con https público. Crear llave de API. Guardar `N8N_URL` y `N8N_API_KEY`.
3. **Anthropic:** `ANTHROPIC_API_KEY`.
4. **Claves** en el menú del entorno de Claude Code (Network secrets). Nunca en el chat.
5. **Red permitida:** `graph.facebook.com`, `api.anthropic.com`, `*.supabase.co`, dominio de n8n.
6. `node scripts/cli.mjs n8n --enviar` → instala el flujo único. Imprime URL y token del webhook.
7. Subir `formulario/index.html` a un hosting (Vercel) para tener un enlace fijo.

## Por cada cliente nuevo

**Lo hace la persona (Meta lo exige):**
- Verificar su negocio en Meta, tener un número libre y método de pago.
- Darnos acceso: usuario del sistema con token, o agregar a David como administrador.
- Llenar el formulario y mandar el texto.

**Lo hace Claude (con el texto guardado en `clientes/<negocio>.json`):**

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
- Salud en EE. UU. queda bloqueado. No se conecta a WhatsApp.
- Cada cliente tiene su propia cuenta de Meta y su propio número.
- Los datos de clientes reales no se suben al repo si son privados.
