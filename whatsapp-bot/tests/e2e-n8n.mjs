// Prueba de extremo a extremo con un n8n REAL. Pesada: no corre con "npm test". Uso:
//   N8N_BIN=/ruta/a/node_modules/.bin/n8n node tests/e2e-n8n.mjs
// Levanta: Postgres en memoria con el esquema real (hace de Supabase), un "Meta" y un "Anthropic" simulados, y n8n de verdad.
// Instala el flujo con el mismo comando que se usará en producción (scripts/cli.mjs n8n --enviar) y le manda webhooks firmados.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';

const N8N_BIN = process.env.N8N_BIN; if (!N8N_BIN) { console.error('Falta N8N_BIN'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esperar = async (fn, ms = 30000, msg = 'condición') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250); } throw new Error('Tiempo agotado esperando: ' + msg); };
const lee = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => r(b)); });
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/* ---------- "Supabase": Postgres real en memoria con nuestro esquema ---------- */
const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`);
await db.exec(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
await db.exec('grant all on all tables in schema public to service_role; grant usage on schema public to service_role;');
const SERVICE_KEY = 'service-key-' + crypto.randomBytes(6).toString('hex');
let llamadasSupabase = 0, clavesMalas = 0;
const supa = http.createServer(async (req, res) => {
  const body = await lee(req); const j = body ? JSON.parse(body) : null;
  if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== 'Bearer ' + SERVICE_KEY) { clavesMalas++; res.writeHead(401); return res.end('{}'); }
  llamadasSupabase++;
  try {
    await db.exec('set role service_role');
    let out;
    const rpc = req.url.match(/^\/rest\/v1\/rpc\/(\w+)/);
    if (rpc) {
      const k = Object.keys(j);
      const r = await db.query(`select ${rpc[1]}(${k.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, k.map(n => j[n] !== null && typeof j[n] === 'object' ? JSON.stringify(j[n]) : j[n]));
      out = r.rows[0].r;
    } else {   // mini PostgREST: upsert
      const m = req.url.match(/^\/rest\/v1\/(\w+)\?on_conflict=([\w,]+)/);
      for (const f of j) {
        const cols = Object.keys(f);
        await db.query(`insert into ${m[1]} (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) on conflict (${m[2]}) do update set ${cols.map(c => `${c}=excluded.${c}`).join(',')}`, cols.map(c => f[c]));
      }
      out = null;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: String(e.message) })); }
  finally { await db.exec('reset role'); }
});

/* ---------- "Meta" (Graph API) ---------- */
const enviados = []; let fallaPlantillas = false;
const graph = http.createServer(async (req, res) => {
  const j = JSON.parse((await lee(req)) || '{}');
  const reg = { url: req.url, auth: req.headers.authorization, ...j }; enviados.push(reg);
  if (j.type === 'template' && fallaPlantillas) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"template not approved"}}'); }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: j.to }], messages: [{ id: 'wamid.out' + enviados.length }] }));
});
/* ---------- "Anthropic" ---------- */
const llamadasIA = [];
const ia = http.createServer(async (req, res) => {
  const j = JSON.parse(await lee(req)); llamadasIA.push({ key: req.headers['x-api-key'], ...j });
  const texto = j.messages[0].content;
  if (/Translate business answers/.test(j.system || '')) { const o = JSON.parse(texto); const t = {}; for (const k of Object.keys(o)) t[k] = '[es] ' + o[k]; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(t) }] })); }
  const out = /jard[ií]n/.test(texto) ? { intencion: 'otro', resuelto: true, respuesta: 'Sí, tenemos un jardín con bar para los huéspedes.' } : { intencion: 'otro', resuelto: false, respuesta: '' };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
});
const [pSupa, pGraph, pIA] = [await listen(supa), await listen(graph), await listen(ia)];

/* ---------- n8n real ---------- */
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-e2e-'));
const PN8N = 5688, BASE = `http://127.0.0.1:${PN8N}`;
const n8n = spawn(N8N_BIN, ['start'], { env: { PATH: process.env.PATH, HOME: carpeta, N8N_USER_FOLDER: carpeta, N8N_PORT: String(PN8N), N8N_HOST: '127.0.0.1', N8N_LISTEN_ADDRESS: '127.0.0.1', N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false', N8N_PERSONALIZATION_ENABLED: 'false', N8N_SECURE_COOKIE: 'false', N8N_RUNNERS_ENABLED: 'true', N8N_RUNNERS_BROKER_PORT: '5791', N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false' } });
let logN8n = ''; n8n.stdout.on('data', d => logN8n += d); n8n.stderr.on('data', d => logN8n += d);
const apagar = () => { try { n8n.kill('SIGTERM'); } catch {} supa.close(); graph.close(); ia.close(); };
process.on('exit', apagar);
let resultado = 0;
try {
  await esperar(() => /Editor is now accessible/.test(logN8n), 180000, 'n8n arriba');
  console.log('n8n arriba');

  // dueño + llave de API (igual que haría una persona en Settings → n8n API)
  const jar = []; const rest = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', cookie: jar.join('; ') }, body: b ? JSON.stringify(b) : undefined }); (r.headers.getSetCookie?.() || []).forEach(c => jar.push(c.split(';')[0])); return { status: r.status, json: await r.json().catch(() => null) }; };
  const setup = await rest('POST', '/rest/owner/setup', { email: 'dueno@test.com', firstName: 'D', lastName: 'R', password: 'Contrasena123' });
  assert.ok(setup.status < 300, 'owner/setup ' + setup.status + JSON.stringify(setup.json));
  const key = await rest('POST', '/rest/api-keys', { label: 'e2e', scopes: ['workflow:create', 'workflow:update', 'workflow:read', 'workflow:list', 'workflow:activate', 'credential:create'], expiresAt: null });
  assert.ok(key.status < 300, 'api-keys ' + key.status + JSON.stringify(key.json));
  const apiKey = key.json.data.rawApiKey;

  // cliente en la "base" con el mismo comando de producción
  const cliente = { ...JSON.parse(fs.readFileSync(new URL('../clientes/arcosodi.json', import.meta.url), 'utf8')), telefono_bot: '529510000000', dueno_nombre: 'Lucía', dueno_telefono: '5219510000009', resp_horarios: 'Check-in 3 pm, check-out 12 pm.', resp_servicios: 'Desayuno incluido y jardín con bar.' };
  const fcli = path.join(carpeta, 'cliente.json'); fs.writeFileSync(fcli, JSON.stringify(cliente));
  const run = promisify(execFile);
  const APP_SECRET = 'app-secret-prueba', TOKEN_META = 'EAAtoken-prueba', VERIFY = 'verifica-123', PATH_WH = 'wa-e2e';
  const env = { PATH: process.env.PATH, SUPABASE_URL: `http://127.0.0.1:${pSupa}`, SUPABASE_SERVICE_KEY: SERVICE_KEY, N8N_URL: BASE, N8N_API_KEY: apiKey, ANTHROPIC_API_KEY: 'sk-ant-prueba',
    META_PHONE_NUMBER_ID: 'PID_E2E', META_WABA_ID: 'WABA_E2E', META_TOKEN: TOKEN_META, META_APP_SECRET: APP_SECRET, WA_VERIFY_TOKEN: VERIFY, WEBHOOK_PATH: PATH_WH,
    GRAPH_ORIGIN: `http://127.0.0.1:${pGraph}`, ANTHROPIC_URL: `http://127.0.0.1:${pIA}/v1/messages`, ESPERA_MIN: '1', ESPERA_MAX: '1' };
  const cli = (...a) => run('node', [new URL('../scripts/cli.mjs', import.meta.url).pathname, ...a, '--enviar'], { env });
  console.log((await cli('aplicar', fcli)).stdout.trim());
  const dep = await cli('n8n'); console.log(dep.stdout.trim());
  assert.match(dep.stdout, /y activo/);

  // ---------- helpers de prueba ----------
  const firmar = raw => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  let n = 0;
  const entrante = (from, texto, { wa, tipo = 'text', pid = 'PID_E2E' } = {}) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA_E2E', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '529510000000', phone_number_id: pid }, contacts: [{ profile: { name: 'Cliente ' + from.slice(-4) }, wa_id: from }],
    messages: [{ from, id: wa || 'wamid.in' + ++n, timestamp: String(Math.floor(Date.now() / 1000)), type: tipo, ...(tipo === 'text' ? { text: { body: texto } } : { image: { id: 'img' } }) }] } }] }] });
  const enviar = async (cuerpo, { firma = true } = {}) => {
    const raw = JSON.stringify(cuerpo);
    const r = await fetch(`${BASE}/webhook/${PATH_WH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(firma ? { 'x-hub-signature-256': firmar(raw) } : {}) }, body: raw });
    return r.status;
  };
  const respuestasA = to => enviados.filter(e => e.to === to && e.type === 'text');
  const dice = async (from, texto, opts) => {
    const antes = respuestasA(from).length;
    assert.equal(await enviar(entrante(from, texto, opts)), 200);
    await esperar(() => respuestasA(from).length > antes, 40000, `respuesta a "${texto}"`);
    await sleep(300);
    return respuestasA(from).at(-1).text.body;
  };
  const ok = (nombre) => console.log('  ✓ ' + nombre);

  // ---------- 1. verificación de Meta ----------
  await esperar(async () => (await fetch(`${BASE}/webhook/${PATH_WH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status === 200, 30000, 'webhook registrado');
  let r = await fetch(`${BASE}/webhook/${PATH_WH}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
  assert.equal(await r.text(), '12345'); ok('GET de verificación devuelve el desafío');
  r = await fetch(`${BASE}/webhook/${PATH_WH}?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=12345`);
  assert.equal(r.status, 403); ok('token incorrecto → 403');

  // ---------- 2. firma falsa ----------
  const raw = JSON.stringify(entrante('5219511110001', 'hola'));
  await fetch(`${BASE}/webhook/${PATH_WH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(raw + ' ') }, body: raw });   // firma de otro cuerpo
  await enviar(entrante('5219511110001', 'hola'), { firma: false });                                                                                                    // sin firma
  assert.equal(await dice('5219511110002', 'hola') !== '', true);                                                                                                       // una válida sí contesta
  assert.equal(respuestasA('5219511110001').length, 0, 'firma falsa no debe contestar');
  assert.equal((await db.query(`select count(*)::int n from conversaciones where telefono='5219511110001'`)).rows[0].n, 0, 'nada se guarda con firma mala');
  ok('firma falsa o ausente: ni responde ni guarda');

  // ---------- 3. saludo y datos fijos ----------
  const A = '5219512220000';
  let t = await dice(A, 'hola buenas'); assert.match(t, /1\. Reservar/); assert.match(t, /ArcoSodi/); ok('saludo → menú');
  t = await dice(A, '¿cuánto cuesta?'); assert.match(t, /\$3,400/); ok('tarifas desde la base');
  const salida = enviados.find(e => e.to === A); assert.equal(salida.auth, 'Bearer ' + TOKEN_META); assert.match(salida.url, /\/PID_E2E\/messages$/); ok('responde por el canal correcto con el token del cliente');

  // ---------- 4. reserva completa ----------
  const B = '5219513330000'; const fut = new Date(Date.now() + 70 * 864e5); const dia = fut.getUTCDate(), mes = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][fut.getUTCMonth()];
  assert.match(await dice(B, 'quiero reservar'), /¿Qué día llegas\?/);
  assert.match(await dice(B, `${dia} de ${mes}`), /¿Qué día sales\?/);
  assert.match(await dice(B, '3 noches'), /¿Cuántas personas/);
  assert.match(await dice(B, 'somos 2'), /¿A nombre de quién/);
  t = await dice(B, 'Ana López'); assert.match(t, /Revisa tu solicitud/); assert.match(t, /\(3 noches\)/);
  t = await dice(B, 'sí'); assert.match(t, /folio ([0-9A-F]{6})/); assert.match(t, /todavía no una reserva confirmada/);
  const folio = t.match(/folio ([0-9A-F]{6})/)[1];
  const res = (await db.query('select * from reservaciones where folio=$1', [folio])).rows[0];
  assert.equal(res.nombre, 'Ana López'); assert.equal(res.personas, 2); assert.equal(res.estado, 'pendiente'); assert.equal(res.telefono, B);
  await esperar(() => enviados.some(e => e.type === 'template' && e.template.name === 'nueva_solicitud_reserva'), 20000, 'aviso al dueño');
  const aviso = enviados.find(e => e.type === 'template' && e.template.name === 'nueva_solicitud_reserva');
  assert.equal(aviso.to, '5219510000009'); assert.equal(aviso.template.components[0].parameters[0].text, folio);
  ok('reserva de 5 pasos guardada en la base, con folio, y aviso al dueño por plantilla');

  // ---------- 5. escalar a humano y silencio ----------
  const C = '5219514440000';
  t = await dice(C, 'quiero hablar con una persona'); assert.match(t, /Lucía/);
  await esperar(() => enviados.some(e => e.type === 'template' && e.template.name === 'aviso_escalamiento' && e.template.components[0].parameters[1].text === C), 20000, 'aviso de escalamiento');
  await sleep(1500);
  const conv = (await db.query(`select estado, pausado_hasta > now() as pausado from conversaciones where telefono=$1`, [C])).rows[0];
  assert.equal(conv.estado, 'humano'); assert.equal(conv.pausado, true);
  const antesC = respuestasA(C).length;
  assert.equal(await enviar(entrante(C, 'hola? sigues ahí?')), 200); await sleep(7000);
  assert.equal(respuestasA(C).length, antesC, 'durante la pausa el bot no contesta');
  assert.equal((await db.query(`select count(*)::int n from mensajes m join conversaciones c on c.id=m.conversacion_id where c.telefono=$1 and m.direccion='in'`, [C])).rows[0].n, 2, 'pero el mensaje sí queda registrado');
  ok('escalamiento: avisa al dueño, pausa y no interrumpe');

  // ---------- 6. IA acotada ----------
  const D = '5219515550000';
  t = await dice(D, 'oigan y ese jardín es para todos?'); assert.match(t, /jardín con bar/);
  assert.equal(llamadasIA.at(-1).key, 'sk-ant-prueba'); assert.match(llamadasIA.at(-1).system, /Desayuno incluido y jardín con bar/); assert.match(llamadasIA.at(-1).messages[0].content, /^<mensaje>/);
  ok('mensaje desconocido → Claude contesta solo con datos del negocio');
  t = await dice(D, 'organizan bodas en la luna?'); assert.match(t, /Ese dato lo confirma una persona/); ok('sin dato → no inventa');

  // ---------- 7. webhook repetido ----------
  const E = '5219516660000'; const cuerpo = entrante(E, 'hola', { wa: 'wamid.repetido' });
  await enviar(cuerpo); await enviar(cuerpo); await enviar(cuerpo);
  await esperar(() => respuestasA(E).length >= 1, 30000, 'primera respuesta'); await sleep(6000);
  assert.equal(respuestasA(E).length, 1); ok('Meta reenvía 3 veces el mismo mensaje → 1 sola respuesta');

  // ---------- 8. mensaje que no es texto ----------
  const F = '5219517770000';
  assert.equal(await enviar(entrante(F, '', { tipo: 'image' })), 200);
  await esperar(() => respuestasA(F).length, 30000, 'respuesta a imagen'); assert.match(respuestasA(F)[0].text.body, /solo puedo leer texto/); ok('foto → pide texto');

  // ---------- 9. si no se puede avisar al dueño, no se promete que se avisó ----------
  fallaPlantillas = true;
  const G = '5219518880000';
  t = await dice(G, 'esto es una estafa, me cobraron doble'); assert.match(t, /Intenté avisar/); assert.doesNotMatch(t, /Ya avisé/);
  fallaPlantillas = false; ok('aviso al dueño falla → el cliente recibe una respuesta honesta');

  // ---------- 10. si la base falla al guardar la reserva, no se confirma ----------
  const H = '5219519990000'; const iso = d => d.toISOString().slice(0, 10);
  await dice(H, `quiero reservar ${iso(fut)} ${iso(new Date(+fut + 2 * 864e5))} para 2 personas a nombre de Luis`);
  await db.exec('alter table reservaciones add constraint no_reservar check (false) not valid');
  t = await dice(H, 'sí'); assert.doesNotMatch(t, /Recibí tu solicitud/); assert.match(t, /problema al guardar/);
  await db.exec('alter table reservaciones drop constraint no_reservar'); ok('fallo de base de datos → no dice "recibida", avisa a una persona');

  // ---------- 11. segundo cliente: hotel en EE. UU., en inglés ----------
  const us = { nombre: 'Maple Inn', giro: 'hotel', pais: 'US', idioma: 'en', salud: 'no', direccion: '12 Maple St, Portland, OR', zona_horaria: 'America/Los_Angeles', telefono_bot: '15551230000', dueno_nombre: 'Sam', dueno_telefono: '15557654321',
    resp_tarifas: 'Rooms from $189 per night, breakfast included.', resp_horarios: 'Check-in 3 PM, check-out 11 AM.', resp_ubicacion: '12 Maple St, Portland.', saludo: 'Hi, thanks for messaging {nombre}.' };
  const fus = path.join(carpeta, 'us.json'); fs.writeFileSync(fus, JSON.stringify(us));
  const env2 = { ...env, META_PHONE_NUMBER_ID: 'PID_US', META_WABA_ID: 'WABA_US' };
  const ap = await run('node', [new URL('../scripts/cli.mjs', import.meta.url).pathname, 'aplicar', fus, '--traducir', '--enviar'], { env: env2 }); assert.match(ap.stdout, /Traducidas 3 respuesta/);
  const U = '15551110000', usd = (from, texto, o) => dice(from, texto, { ...o, pid: 'PID_US' });
  t = await usd(U, 'hello'); assert.match(t, /^Hi, thanks for messaging Maple Inn\./); assert.match(t, /1\. Book a room/);
  t = await usd(U, 'how much is a room?'); assert.match(t, /\$189 per night/); assert.match(enviados.at(-1).url, /PID_US\/messages$/);
  t = await usd('15551110001', 'hola, ¿cuánto cuesta una habitación?'); assert.match(t, /^\[es\] Rooms from \$189/);
  ok('cliente de EE. UU.: contesta en inglés, y en español (traducido) a quien escribe en español');
  const d2 = new Date(Date.now() + 40 * 864e5), iso2 = x => x.toISOString().slice(0, 10), mdy = x => `${x.getUTCMonth() + 1}/${x.getUTCDate()}`;
  const V = '15551110002';
  assert.match(await usd(V, 'I want to book a room'), /What day do you arrive\?/);
  assert.match(await usd(V, mdy(d2)), /What day do you leave\?/);                              // 11/20 se lee mes/día
  assert.match(await usd(V, '2 nights'), /How many guests\?/);
  assert.match(await usd(V, 'two'), /What name should the request/);
  t = await usd(V, 'Sarah Johnson'); assert.match(t, new RegExp(`Arrival: .*${d2.getUTCFullYear()}`)); assert.match(t, /\(2 nights\)/);
  t = await usd(V, 'yes'); assert.match(t, /reference [0-9A-F]{6}/); assert.match(t, /not a confirmed booking yet/);
  const fol = t.match(/reference ([0-9A-F]{6})/)[1];
  assert.equal((await db.query('select fecha_inicio::text f from reservaciones where folio=$1', [fol])).rows[0].f, iso2(d2));
  await esperar(() => enviados.some(e => e.type === 'template' && e.template.name === 'nueva_solicitud_reserva_en'), 20000, 'aviso en inglés');
  const av = enviados.find(e => e.type === 'template' && e.template.name === 'nueva_solicitud_reserva_en');
  assert.equal(av.to, '15557654321'); assert.equal(av.template.language.code, 'en_US'); assert.match(av.template.components[0].parameters[2].text, / to /);
  t = await usd('15551110003', 'let me speak to a person'); assert.match(t, /let Sam know/);
  await esperar(() => enviados.some(e => e.type === 'template' && e.template.name === 'aviso_escalamiento_en'), 20000, 'escalamiento en inglés');
  assert.equal(enviados.find(e => e.template && e.template.name === 'aviso_escalamiento_en').template.components[0].parameters[2].text, 'Asked to talk to a person');
  ok('reserva en inglés con fecha mes/día, aviso al dueño con plantilla en inglés (en_US) y motivo en inglés');

  assert.equal(clavesMalas, 0, 'n8n debe mandar la llave de servicio correcta'); ok(`la credencial de Supabase llegó bien (${llamadasSupabase} llamadas)`);
  console.log('\nTODO BIEN: flujo real de n8n verificado de punta a punta');
} catch (e) {
  resultado = 1; console.error('\nFALLÓ:', e.stack || e); console.error('\n--- log de n8n (últimas líneas) ---\n' + logN8n.split('\n').slice(-40).join('\n'));
} finally { apagar(); setTimeout(() => process.exit(resultado), 500); }
