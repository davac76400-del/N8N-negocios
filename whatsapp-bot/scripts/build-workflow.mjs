// Genera el flujo de n8n a partir de n8n/code/bot.cjs (una sola fuente de lógica, la misma que prueban los tests).
// Uso:  node scripts/build-workflow.mjs [salida.json]
// Variables: SUPABASE_URL, WA_VERIFY_TOKEN, WEBHOOK_PATH, MODELO_IA (todas opcionales para una vista previa)
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BOT_FUENTE = fs.readFileSync(new URL('../n8n/code/bot.cjs', import.meta.url), 'utf8');
const uuid = () => crypto.randomUUID();

export function buildWorkflow(o = {}) {
  // graphBase y anthropicUrl solo se cambian en las pruebas, para apuntar a servidores simulados
  const BOT = BOT_FUENTE.replaceAll('https://graph.facebook.com', o.graphBase || 'https://graph.facebook.com');
  const opt = {
    supabaseUrl: o.supabaseUrl || 'https://TU-PROYECTO.supabase.co',
    verifyToken: o.verifyToken || 'CAMBIA-ESTE-TOKEN',
    path: o.path || 'whatsapp-bot',
    modelo: o.modelo || 'claude-haiku-5-5',
    credSupabase: o.credSupabase || { id: '', name: 'Supabase service role' },
    credAnthropic: o.credAnthropic || { id: '', name: 'Anthropic API' },
  };
  const esp = { min: 3, max: 10, ...(o.espera || {}) };   // pausa antes de contestar, en segundos (las pruebas la acortan)
  const nodes = [], connections = {};
  let x = 0;
  const add = (name, type, typeVersion, parameters, extra = {}, pos) => {
    nodes.push({ id: uuid(), name, type, typeVersion, position: pos || [x += 240, 300], parameters, ...extra });
    return name;
  };
  const link = (from, to, out = 0) => {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= out) connections[from].main.push([]);
    connections[from].main[out].push({ node: to, type: 'main', index: 0 });
  };
  const code = (name, body, mode = 'runOnceForEachItem', pos) => add(name, 'n8n-nodes-base.code', 2, { mode, jsCode: `${BOT}\n\n// ---------- este nodo ----------\n${body}` }, {}, pos);
  const si = (name, expr, pos) => add(name, 'n8n-nodes-base.if', 2.2, {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: uuid(), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }, {}, pos);
  const supa = (name, fn, bodyExpr, pos) => add(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `${opt.supabaseUrl}/rest/v1/rpc/${fn}`, authentication: 'genericCredentialType', genericAuthType: 'httpCustomAuth',
    sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: {} },
    { credentials: { httpCustomAuth: opt.credSupabase }, retryOnFail: true, maxTries: 2, waitBetweenTries: 800 }, pos);
  const graph = (name, bodyExpr, pos) => add(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: '={{ $json.url }}', sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $json.ctx.canal.access_token }}" }] },
    sendBody: true, specifyBody: 'json', jsonBody: bodyExpr, options: {} },
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 1500, onError: 'continueRegularOutput' }, pos);

  /* --- verificación de Meta (GET) --- */
  const wGet = add('Meta verifica (GET)', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: opt.path, responseMode: 'responseNode', options: {} }, { webhookId: uuid() }, [0, 80]);
  const tokOk = si('¿Token correcto?', `={{ $json.query['hub.mode'] === 'subscribe' && $json.query['hub.verify_token'] === ${JSON.stringify(opt.verifyToken)} }}`, [240, 80]);
  const resp = add('Devolver desafío', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: "={{ $json.query['hub.challenge'] }}", options: { responseCode: 200 } }, {}, [480, 20]);
  const nega = add('Rechazar', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'text', responseBody: 'forbidden', options: { responseCode: 403 } }, {}, [480, 160]);
  link(wGet, tokOk); link(tokOk, resp, 0); link(tokOk, nega, 1);

  /* --- mensajes (POST) --- */
  x = -240;
  const wPost = add('Meta envía (POST)', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: opt.path, responseMode: 'onReceived', options: { rawBody: true } }, { webhookId: uuid() }, [0, 400]);
  const parse = code('Parsear', `
const item = $input.first();
const body = item.json.body ?? item.json;
const firma = (item.json.headers || {})['x-hub-signature-256'] || '';
let raw = '';
try { raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('base64'); } catch (e) {}
return parsearWebhook(body).map(m => ({ json: { ...m, firma, rawB64: raw } }));`, 'runOnceForAllItems', [240, 400]);
  const canal = supa('Canal', 'bot_canal', '={{ JSON.stringify({ p_phone_number_id: $json.phone_number_id }) }}', [480, 400]);
  const firma = code('Firma', `
const msg = { ...$('Parsear').item.json }; const rawB64 = msg.rawB64; delete msg.rawB64;
return { json: { ok: $json.ok === true && verificarFirma(rawB64, msg.firma, $json.app_secret), msg } };`, 'runOnceForEachItem', [720, 400]);
  const firmaOk = si('¿Firma válida?', '={{ $json.ok }}', [960, 400]);
  const ctx = supa('Contexto', 'bot_contexto', '={{ JSON.stringify({ p_phone_number_id: $json.msg.phone_number_id, p_from: $json.msg.from, p_wa_id: $json.msg.wa_id, p_texto: $json.msg.texto, p_nombre: $json.msg.nombre_perfil }) }}', [1200, 400]);
  const sigue = si('¿Contesta el bot?', '={{ $json.ok === true && $json.duplicado === false && $json.pausado === false }}', [1440, 400]);
  const ahora = "new Date().toISOString()";
  const decide = code('Decidir', `
const ctx = $json, msg = $('Firma').item.json.msg;
const r = decidir({ texto: msg.texto, tipo: msg.tipo, ahora: ${ahora}, cliente: ctx.cliente, respuestas: ctx.respuestas, conv: { ...ctx.conv, es_nueva: ctx.es_nueva } });
return { json: { msg, ctx, r } };`, 'runOnceForEachItem', [1680, 400]);
  const necesitaIA = si('¿Necesita IA?', '={{ $json.r.needs_llm }}', [1920, 400]);
  const prepIA = code('Preparar IA', `
const { msg, ctx } = $json; const p = promptLLM(ctx.cliente, ctx.respuestas, msg.texto);
return { json: { msg, ctx, req: { model: ${JSON.stringify(opt.modelo)}, max_tokens: 300, system: p.system, messages: [{ role: 'user', content: p.user }] } } };`, 'runOnceForEachItem', [2160, 520]);
  const claude = add('Claude (solo si hace falta)', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: o.anthropicUrl || 'https://api.anthropic.com/v1/messages', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.req) }}', options: { timeout: 20000 } },
    { credentials: { httpHeaderAuth: opt.credAnthropic }, onError: 'continueRegularOutput' }, [2400, 520]);
  const leeIA = code('Leer IA', `
const base = $('Preparar IA').item.json; let llm = null;
try { llm = leerLLM(($json.content || []).map(c => c.text || '').join(''), base.ctx.respuestas); } catch (e) {}
const r = decidir({ texto: base.msg.texto, tipo: base.msg.tipo, ahora: ${ahora}, cliente: base.ctx.cliente, respuestas: base.ctx.respuestas, conv: { ...base.ctx.conv, es_nueva: base.ctx.es_nueva }, llm, llm_error: !llm });
return { json: { msg: base.msg, ctx: base.ctx, r } };`, 'runOnceForEachItem', [2640, 520]);
  const esReserva = si('¿Confirmó la reserva?', "={{ $json.r.accion === 'reservar' }}", [2880, 400]);
  const guarda = supa('Guardar reserva', 'bot_reservar', '={{ JSON.stringify({ p_conv: $json.ctx.conv.id, p_nombre: $json.r.reserva.nombre, p_personas: $json.r.reserva.personas, p_inicio: $json.r.reserva.fecha_inicio, p_fin: $json.r.reserva.fecha_fin, p_hora: $json.r.reserva.hora, p_detalle: $json.r.reserva.detalle }) }}', [3120, 280]);
  nodes.at(-1).onError = 'continueRegularOutput';
  const cierra = code('Cerrar reserva', `
const base = $('¿Confirmó la reserva?').item.json; const ok = $json.ok === true && !!$json.folio;
const f = finalizarReserva({ ok, folio: $json.folio, cliente: base.ctx.cliente, nombre: base.r.reserva.nombre, idioma: base.r.idioma });
return { json: { msg: base.msg, ctx: base.ctx, r: { ...base.r, reply: f.reply, accion: f.accion, motivo: f.motivo, borrador: null, intentos: 0, intencion: 'reservar', idioma: base.r.idioma, folio: ok ? $json.folio : null } } };`, 'runOnceForEachItem', [3360, 280]);
  const prepara = code('Preparar envío', `
const { msg, ctx, r } = $json; let aviso = null;
const en = ctx.cliente.idioma === 'en', sufijo = en ? '_en' : '', lang = en ? 'en_US' : 'es_MX', dueno = ctx.cliente.dueno_telefono;
if (r.accion === 'escalar') aviso = { payload: mensajePlantilla(dueno, 'aviso_escalamiento' + sufijo, [msg.nombre_perfil || msg.from, msg.from, motivo(r.motivo || '-', ctx.cliente.idioma)], lang) };
else if (r.folio) aviso = { payload: mensajePlantilla(dueno, 'nueva_solicitud_reserva' + sufijo, [r.folio, r.reserva.nombre || msg.from, [r.reserva.fecha_inicio, r.reserva.fecha_fin].filter(Boolean).join(en ? ' to ' : ' a ') + (r.reserva.hora ? ' ' + r.reserva.hora : '') + (r.reserva.personas ? ' · ' + r.reserva.personas : '')], lang) };
return { json: { msg, ctx, r, url: urlEnvio(ctx.canal.phone_number_id), aviso } };`, 'runOnceForEachItem', [3600, 400]);
  const hayAviso = si('¿Avisar a una persona?', '={{ !!$json.aviso }}', [3840, 400]);
  const avisa = graph('Avisar a una persona', '={{ JSON.stringify($json.aviso.payload) }}', [4080, 280]);
  const arma = code('Armar mensaje', `
const base = $('Preparar envío').item.json; let texto = base.r.reply;
const fallo = base.aviso && ($json.error || !($json.messages && $json.messages.length));
if (fallo && base.r.accion === 'escalar') texto = T[base.r.idioma || 'es'].avisoFalla;
return { json: { ...base, texto, aviso_fallo: !!fallo, payload: mensajeTexto(base.msg.from, texto) } };`, 'runOnceForEachItem', [4320, 400]);
  const espera = add('Pausa humana (3-10 s)', 'n8n-nodes-base.wait', 1.1, { amount: `={{ Math.floor(${esp.min} + Math.random() * ${esp.max - esp.min}) }}`, unit: 'seconds' }, { webhookId: uuid() }, [4560, 400]);
  const envia = graph('Enviar al cliente', '={{ JSON.stringify($json.payload) }}', [4800, 400]);
  const guardaResp = supa('Guardar respuesta', 'bot_responder', "={{ (() => { const b = $('Armar mensaje').item.json; return JSON.stringify({ p_conv: b.ctx.conv.id, p_texto: b.texto, p_intencion: b.r.intencion, p_borrador: b.r.borrador, p_intentos: b.r.intentos, p_humano: b.r.accion === 'escalar', p_idioma: b.r.idioma }); })() }}", [5040, 400]);

  link(wPost, parse); link(parse, canal); link(canal, firma); link(firma, firmaOk); link(firmaOk, ctx, 0);
  link(ctx, sigue); link(sigue, decide, 0); link(decide, necesitaIA);
  link(necesitaIA, prepIA, 0); link(necesitaIA, esReserva, 1);
  link(prepIA, claude); link(claude, leeIA); link(leeIA, esReserva);
  link(esReserva, guarda, 0); link(esReserva, prepara, 1); link(guarda, cierra); link(cierra, prepara);
  link(prepara, hayAviso); link(hayAviso, avisa, 0); link(hayAviso, arma, 1); link(avisa, arma);
  link(arma, espera); link(espera, envia); link(envia, guardaResp);

  add('Leeme', 'n8n-nodes-base.stickyNote', 1, { width: 520, height: 300, content:
`## Bot de WhatsApp (Cloud API de Meta)
1. Meta -> tu app -> WhatsApp -> Configuración: URL de devolución = la URL de producción de "Meta envía" y token = el de "¿Token correcto?".
2. Credenciales: "Supabase service role" (Custom Auth: apikey + Authorization) y "Anthropic API" (Header Auth: x-api-key).
3. Esta pestaña se genera con scripts/build-workflow.mjs. No la edites a mano: cambia n8n/code/bot.cjs.
4. Recomendado: EXECUTIONS_DATA_SAVE_ON_SUCCESS=none (el contexto lleva el token del canal).` }, {}, [0, 620]);

  return { name: 'Bot de WhatsApp (multi-cliente)', nodes, connections, settings: { executionOrder: 'v1' } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || new URL('../n8n/whatsapp-bot.workflow.json', import.meta.url).pathname;
  const wf = buildWorkflow({ supabaseUrl: process.env.SUPABASE_URL, verifyToken: process.env.WA_VERIFY_TOKEN, path: process.env.WEBHOOK_PATH, modelo: process.env.MODELO_IA });
  fs.writeFileSync(out, JSON.stringify(wf, null, 2));
  console.log(`Flujo escrito en ${out} (${wf.nodes.length} nodos)`);
}
