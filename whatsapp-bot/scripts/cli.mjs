#!/usr/bin/env node
// Automatiza el alta de un cliente. Por defecto TODO es ensayo (no manda nada): agrega --enviar para ejecutar de verdad.
// Los secretos se leen de variables de entorno; nunca se imprimen ni se guardan en archivos.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildWorkflow } from './build-workflow.mjs';

const aqui = p => new URL(p, import.meta.url);
const leer = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const FORM = leer(aqui('../clientes/formulario.json'));
const GRAPH = process.env.GRAPH_BASE || 'https://graph.facebook.com/v23.0';   // VERIFICAR versión vigente
const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--'))), pos = args.filter(a => !a.startsWith('--'));
const ENVIAR = flags.has('--enviar');
const env = k => process.env[k] || '';
const faltan = ks => ks.filter(k => !env(k));

/* ---------- cliente ---------- */
export function validar(c) {
  const errores = [];
  for (const sec of FORM.secciones) for (const f of sec.campos) {
    const v = c[f.clave], et = f.etiqueta.es;
    if (f.paises && !f.paises.includes(c.pais)) continue;                      // política que solo aplica a un país
    if (f.opcionesPor && !f.opcionesPor[c.pais]) continue;                      // estado: solo México y EE. UU.
    const vacio = v === undefined || v === null || String(v).trim() === '' || /^VERIFICAR/i.test(String(v));
    if (f.requerido && vacio) { errores.push(`Falta: ${et} (${f.clave})`); continue; }
    if (vacio) continue;
    if (f.tipo === 'telefono' && !/^\d{10,15}$/.test(String(v))) errores.push(`${et}: solo dígitos con lada de país, por ejemplo 529511234567 o 15551234567`);
    if (f.tipo === 'correo' && !/^\S+@\S+\.\S+$/.test(v)) errores.push(`${et}: correo no válido`);
    const ops = f.opcionesPor ? f.opcionesPor[c.pais].map(v => ({ v })) : f.opciones;
    if (f.tipo === 'opcion' && !ops.some(o => o.v === v)) errores.push(`${et}: debe ser ${ops.map(o => o.v).join(' o ')}`);
    if (f.tipo === 'entero' && !Number.isInteger(Number(v))) errores.push(`${et}: debe ser un número entero`);
  }
  if (c.salud === 'si' && c.pais === 'US') errores.push('BLOQUEADO: un negocio de salud en Estados Unidos no puede usar WhatsApp. Meta no firma el acuerdo de HIPAA (BAA) y su política restringe datos de salud. Ofrece SMS con un proveedor que firme BAA, y consulta a un asesor de HIPAA.');
  return errores;
}
export function avisos(c) {
  const a = [];
  if (c.salud === 'si' && c.pais !== 'US') a.push('Negocio de salud fuera de EE. UU.: pide consentimiento expreso para tratar datos de salud (en México, LFPDPPP), no guardes datos clínicos y revisa la política de Meta de tu país. El asistente avisa que no se comparta información médica.');
  if (c.pais === 'US') a.push('EE. UU.: WhatsApp es menos usado que SMS. Confirma que los clientes finales del negocio usan WhatsApp antes de venderlo.');
  return a;
}
const idCliente = c => { const h = crypto.createHash('sha1').update('cliente:' + c.nombre.trim().toLowerCase()).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const CLAVES = { resp_tarifas: 'tarifas', resp_horarios: 'horarios', resp_ubicacion: 'ubicacion', resp_servicios: 'servicios', resp_politicas: 'politicas' };
const textoOk = v => v && String(v).trim() && !/^VERIFICAR/i.test(String(v));

export function filas(c, traducidas = []) {
  const id = idCliente(c);
  return {
    cliente: { id, nombre: c.nombre, giro: c.giro, pais: c.pais, idioma: c.idioma, salud: c.salud === 'si', ciudad: c.ciudad || null, estado: c.estado || null, direccion: c.direccion, zona_horaria: c.zona_horaria,
      dueno_nombre: c.dueno_nombre, dueno_telefono: c.dueno_telefono, dueno_correo: c.dueno_correo || null, saludo: c.saludo || null, pausa_min: Number(c.pausa_min) || 30 },
    respuestas: Object.entries(CLAVES).filter(([k]) => textoOk(c[k])).map(([k, clave]) => ({ cliente_id: id, clave, idioma: c.idioma, texto: c[k] })),
    traducidas: traducidas.map(r => ({ cliente_id: id, ...r })),
    canal: env('META_PHONE_NUMBER_ID') ? { cliente_id: id, phone_number_id: env('META_PHONE_NUMBER_ID'), waba_id: env('META_WABA_ID') || null, telefono: c.telefono_bot, access_token: env('META_TOKEN') || null, app_secret: env('META_APP_SECRET') || null } : null,
  };
}
const q = v => v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const upsert = (tabla, f, conflicto) => `insert into ${tabla} (${Object.keys(f).join(', ')}) values (${Object.values(f).map(q).join(', ')})\non conflict (${conflicto}) do update set ${Object.keys(f).filter(k => !conflicto.split(', ').includes(k)).map(k => `${k} = excluded.${k}`).join(', ')};`;
export function sql(c) {
  const f = filas(c);
  return [upsert('clientes', f.cliente, 'id'), ...[...f.respuestas, ...f.traducidas].map(r => upsert('respuestas_fijas', r, 'cliente_id, clave, idioma')),
    '-- El canal (número, token y secreto de Meta) se carga con "aplicar", que lee los secretos del entorno y no los escribe en archivos.'].join('\n');
}

/* ---------- red ---------- */
async function http(metodo, url, { headers = {}, body } = {}) {
  const r = await fetch(url, { method: metodo, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch {}
  return { ok: r.ok, status: r.status, json, texto };
}
const ensayo = (titulo, detalle) => console.log(`[ENSAYO] ${titulo}${detalle ? '\n' + JSON.stringify(detalle, null, 2) : ''}`);
const falla = msg => { console.error(msg); process.exit(1); };

/* Traduce las respuestas del negocio al otro idioma con Claude. Si algo no cuadra (JSON roto, enlaces cambiados) esa respuesta se omite y el bot usa la original. */
export async function traducir(c) {
  const de = c.idioma, a = de === 'es' ? 'en' : 'es';
  const orig = Object.fromEntries(Object.entries(CLAVES).filter(([k]) => textoOk(c[k])).map(([k, clave]) => [clave, c[k]]));
  if (!Object.keys(orig).length) return [];
  const url = env('ANTHROPIC_URL') || 'https://api.anthropic.com/v1/messages';
  const r = await http('POST', url, { headers: { 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, body: { model: env('MODELO_IA') || 'claude-haiku-5-5', max_tokens: 2000,
    system: `Translate business answers from ${de === 'es' ? 'Spanish' : 'English'} to ${a === 'es' ? 'Spanish' : 'English'}. Keep numbers, prices, times, URLs and proper names exactly as they are. Do not add or remove information. Reply with strict JSON only: an object with the same keys.`,
    messages: [{ role: 'user', content: JSON.stringify(orig) }] } });
  if (!r.ok) throw new Error(`Anthropic respondió ${r.status}`);
  let j; try { j = JSON.parse(r.json.content.map(x => x.text || '').join('').replace(/^```(?:json)?|```$/gm, '').trim()); } catch { throw new Error('La traducción no llegó como JSON'); }
  const out = [];
  for (const [clave, texto] of Object.entries(orig)) {
    const t = j[clave];
    if (typeof t !== 'string' || !t.trim()) continue;
    if ((texto.match(/https?:\/\/\S+/g) || []).some(u => !t.includes(u))) continue;   // un enlace cambiado no se acepta
    if ((texto.match(/\d[\d,.:]*/g) || []).some(n => !t.includes(n))) continue;          // ni un precio u hora distintos
    out.push({ clave, idioma: a, texto: t.trim() });
  }
  return out;
}

async function cmdAplicar(c) {
  const base = env('SUPABASE_URL'), h = { apikey: env('SUPABASE_SERVICE_KEY'), Authorization: 'Bearer ' + env('SUPABASE_SERVICE_KEY'), Prefer: 'resolution=merge-duplicates,return=minimal' };
  if (!ENVIAR) {
    const f = filas(c);
    for (const a of avisos(c)) console.log('Aviso: ' + a);
    return ensayo('Guardaría en Supabase' + (flags.has('--traducir') ? ' (y traduciría las respuestas al otro idioma con Claude)' : ''), [['clientes', 1], ['respuestas_fijas', f.respuestas.length * (flags.has('--traducir') ? 2 : 1)], ...(f.canal ? [['canales (con secretos)', 1]] : [])].map(([tabla, filas]) => ({ tabla, filas })));
  }
  const m = faltan(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', ...(flags.has('--traducir') ? ['ANTHROPIC_API_KEY'] : [])]); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
  for (const a of avisos(c)) console.log('Aviso: ' + a);
  let alt = [];
  if (flags.has('--traducir')) { alt = await traducir(c); console.log(`Traducidas ${alt.length} respuesta(s) al ${c.idioma === 'es' ? 'inglés' : 'español'}`); }
  const f = filas(c, alt);
  const pasos = [['clientes', [f.cliente], 'id'], ['respuestas_fijas', [...f.respuestas, ...f.traducidas], 'cliente_id,clave,idioma'], ...(f.canal ? [['canales', [f.canal], 'phone_number_id']] : [])];
  for (const [t, rows, conf] of pasos) {
    if (!rows.length) continue;
    const r = await http('POST', `${base}/rest/v1/${t}?on_conflict=${conf}`, { headers: h, body: rows });
    if (!r.ok) falla(`Supabase rechazó ${t}: ${r.status} ${r.texto.slice(0, 200)}`);
    console.log(`OK ${t}: ${rows.length} fila(s)`);
  }
  if (!f.canal) console.log('Aviso: sin META_PHONE_NUMBER_ID no se creó el canal. Se agrega cuando Meta entregue el número.');
}

async function cmdPlantillas() {
  const idiomaArg = (args.find(a => a.startsWith('--idioma=')) || '').slice(9);   // --idioma=en  o  --idioma=es
  const lista = leer(aqui('../plantillas/plantillas.json')).filter(t => !idiomaArg || t.language.startsWith(idiomaArg)), waba = env('META_WABA_ID');
  const h = { Authorization: 'Bearer ' + env('META_TOKEN') };
  if (flags.has('--estado')) {
    const m = faltan(['META_WABA_ID', 'META_TOKEN']); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
    const r = await http('GET', `${GRAPH}/${waba}/message_templates?fields=name,status,rejected_reason,category,language&limit=100`, { headers: h });
    if (!r.ok) falla(`Meta respondió ${r.status}: ${r.texto.slice(0, 300)}`);
    for (const t of r.json.data) console.log(`${t.name} [${t.language}] ${t.status}${t.rejected_reason && t.rejected_reason !== 'NONE' ? ' — rechazo: ' + t.rejected_reason : ''}`);
    return;
  }
  if (!ENVIAR) return ensayo(`Enviaría ${lista.length} plantillas a Meta para aprobación`, lista.map(t => t.name));
  const m = faltan(['META_WABA_ID', 'META_TOKEN']); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
  const ya = await http('GET', `${GRAPH}/${waba}/message_templates?fields=name,language&limit=100`, { headers: h });
  if (!ya.ok) falla(`Meta respondió ${ya.status}: ${ya.texto.slice(0, 300)}`);
  const existentes = new Set((ya.json.data || []).map(t => `${t.name}/${t.language}`));
  for (const t of lista) {
    if (existentes.has(`${t.name}/${t.language}`)) { console.log(`ya existe: ${t.name}`); continue; }
    const r = await http('POST', `${GRAPH}/${waba}/message_templates`, { headers: h, body: t });
    console.log(r.ok ? `enviada: ${t.name} (${r.json.status || 'PENDING'})` : `ERROR ${t.name}: ${r.texto.slice(0, 300)}`);
  }
}

async function cmdWebhookMeta() {
  const url = env('WEBHOOK_URL'), token = env('WA_VERIFY_TOKEN');
  if (!ENVIAR) return ensayo('Registraría el webhook en Meta', { callback_url: url || '(falta WEBHOOK_URL)', campos: ['messages'], suscribir_waba: env('META_WABA_ID') || '(falta)' });
  const m = faltan(['META_APP_ID', 'META_APP_SECRET', 'META_WABA_ID', 'META_TOKEN', 'WEBHOOK_URL', 'WA_VERIFY_TOKEN']); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
  const app = `${env('META_APP_ID')}|${env('META_APP_SECRET')}`;
  let r = await http('POST', `${GRAPH}/${env('META_APP_ID')}/subscriptions`, { headers: { Authorization: 'Bearer ' + app }, body: { object: 'whatsapp_business_account', callback_url: url, verify_token: token, fields: 'messages' } });
  console.log(r.ok ? 'OK webhook registrado (Meta verificó la URL)' : `ERROR webhook: ${r.status} ${r.texto.slice(0, 300)}`);
  r = await http('POST', `${GRAPH}/${env('META_WABA_ID')}/subscribed_apps`, { headers: { Authorization: 'Bearer ' + env('META_TOKEN') } });
  console.log(r.ok ? 'OK app suscrita a la cuenta de WhatsApp Business' : `ERROR suscripción: ${r.status} ${r.texto.slice(0, 300)}`);
}

async function cmdProbar(destino) {
  if (!destino) falla('Uso: probar <numero_destino_con_lada>');
  const cuerpo = { messaging_product: 'whatsapp', to: destino, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };
  if (!ENVIAR) return ensayo('Mandaría el mensaje de prueba hello_world', { a: destino });
  const m = faltan(['META_PHONE_NUMBER_ID', 'META_TOKEN']); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
  const r = await http('POST', `${GRAPH}/${env('META_PHONE_NUMBER_ID')}/messages`, { headers: { Authorization: 'Bearer ' + env('META_TOKEN') }, body: cuerpo });
  console.log(r.ok ? 'OK mensaje de prueba enviado' : `ERROR: ${r.status} ${r.texto.slice(0, 300)}`);
}

async function cmdN8n() {
  const base = env('N8N_URL').replace(/\/$/, ''), h = { 'X-N8N-API-KEY': env('N8N_API_KEY') };
  const verifyToken = env('WA_VERIFY_TOKEN') || crypto.randomBytes(16).toString('hex'), path = env('WEBHOOK_PATH') || 'wa-' + crypto.randomBytes(8).toString('hex');
  const url = `${base || 'https://TU-N8N'}/webhook/${path}`;
  if (!ENVIAR) return ensayo('Crearía en n8n: 2 credenciales + el flujo, y lo activaría', { webhook_url: url, verify_token: verifyToken, nota: 'Guarda este token: es el que se pega en Meta.' });
  const m = faltan(['N8N_URL', 'N8N_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY']); if (m.length) falla('Faltan variables de entorno: ' + m.join(', '));
  const cred = async (name, type, data) => {
    const r = await http('POST', `${base}/api/v1/credentials`, { headers: h, body: { name, type, data } });
    if (!r.ok) falla(`n8n rechazó la credencial ${name}: ${r.status} ${r.texto.slice(0, 200)}`);
    return { id: r.json.id, name };
  };
  const k = env('SUPABASE_SERVICE_KEY');
  const credSupabase = await cred('Supabase service role', 'httpCustomAuth', { json: JSON.stringify({ headers: { apikey: k, Authorization: 'Bearer ' + k } }) });
  const credAnthropic = await cred('Anthropic API', 'httpHeaderAuth', { name: 'x-api-key', value: env('ANTHROPIC_API_KEY') });
  const wf = buildWorkflow({ supabaseUrl: env('SUPABASE_URL').replace(/\/$/, ''), verifyToken, path, modelo: env('MODELO_IA') || undefined, credSupabase, credAnthropic,
    // solo para pruebas con servidores simulados
    graphBase: env('GRAPH_ORIGIN') || undefined, anthropicUrl: env('ANTHROPIC_URL') || undefined, espera: env('ESPERA_MIN') ? { min: +env('ESPERA_MIN'), max: +env('ESPERA_MAX') } : undefined });
  const r = await http('POST', `${base}/api/v1/workflows`, { headers: h, body: wf });
  if (!r.ok) falla(`n8n rechazó el flujo: ${r.status} ${r.texto.slice(0, 400)}`);
  const a = await http('POST', `${base}/api/v1/workflows/${r.json.id}/activate`, { headers: h });
  console.log(`Flujo ${r.json.id} creado${a.ok ? ' y activo' : ' (ACTIVARLO a mano: ' + a.status + ')'}`);
  console.log(`URL del webhook: ${url}\nToken de verificación: ${verifyToken}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a1] = pos;
  const cliente = () => { if (!a1) falla('Falta el archivo del cliente'); return leer(a1); };
  if (cmd === 'validar') { const c = cliente(), e = validar(c); console.log(e.length ? e.join('\n') : 'Todo en orden'); avisos(c).forEach(a => console.log('Aviso: ' + a)); process.exit(e.length ? 1 : 0); }
  else if (cmd === 'sql') console.log(sql(cliente()));
  else if (cmd === 'aplicar') { const c = cliente(), e = validar(c); if (e.length) falla('Corrige primero:\n' + e.join('\n')); await cmdAplicar(c); }
  else if (cmd === 'plantillas') await cmdPlantillas();
  else if (cmd === 'webhook-meta') await cmdWebhookMeta();
  else if (cmd === 'probar') await cmdProbar(a1);
  else if (cmd === 'n8n') await cmdN8n();
  else console.log(`Comandos (agrega --enviar para ejecutar de verdad):
  validar <cliente.json>        revisa que no falte ningún dato
  sql <cliente.json>            muestra el SQL de alta (sin secretos)
  aplicar <cliente.json> [--traducir]  guarda cliente, respuestas y canal en Supabase (traduce las respuestas al otro idioma)
  plantillas [--idioma=en|es] [--estado]  envía las plantillas a Meta / muestra su estado y motivos de rechazo
  webhook-meta                  registra el webhook en Meta y suscribe la app
  probar <numero>               manda hello_world para comprobar el canal
  n8n                           crea credenciales y flujo en n8n y lo activa`);
}
