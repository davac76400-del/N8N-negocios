import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { validar, avisos, sql, filas, traducir } from '../scripts/cli.mjs';
import { buildWorkflow } from '../scripts/build-workflow.mjs';

const run = promisify(execFile);
const leer = p => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const completo = { ...leer('../clientes/arcosodi.json'), estado: 'Oaxaca', razon_social: 'Hotel de prueba SA', sitio_web: 'https://ejemplo.mx', telefono_bot: '529510000000', dueno_nombre: 'Lucía', resp_horarios: 'Check-in 3 pm, check-out 12 pm.' };

test('el formulario detecta lo que falta y no inventa', () => {
  assert.equal(validar({ ...leer('../clientes/arcosodi.json'), estado: 'Oaxaca', razon_social: 'x', sitio_web: 'https://x.mx' }).length, 3);
  assert.deepEqual(validar(completo), []);
  assert.match(validar({ ...completo, telefono_bot: '951 123' }).join(), /solo dígitos/);
  assert.match(validar({ ...completo, giro: 'banco' }).join(), /hotel o restaurante/);
});

test('el SQL de alta se aplica sobre el esquema real y es repetible', async () => {
  const db = new PGlite();
  await db.exec(`create role authenticated nologin; create role service_role nologin; create role anon nologin; create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
  await db.exec(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  const s = sql(completo);
  await db.exec(s); await db.exec(s);
  assert.equal((await db.query('select count(*)::int n from clientes')).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int n from respuestas_fijas')).rows[0].n, 4);   // tarifas, horarios, ubicacion, servicios (políticas vacía)
  const c = (await db.query('select * from clientes')).rows[0];
  assert.equal(c.giro, 'hotel'); assert.equal(c.dueno_telefono, '529511607980');
  assert.doesNotMatch(s, /access_token|app_secret/);
  await db.exec(sql({ ...completo, nombre: "Hotel O'Brien" }));   // comillas
  assert.equal((await db.query('select count(*)::int n from clientes')).rows[0].n, 2);
});

function servidor() {
  const llamadas = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      llamadas.push({ m: req.method, u: req.url, h: req.headers, b: b ? JSON.parse(b) : null });
      const j = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.includes('/message_templates?')) return j(req.url.includes('rejected_reason')
        ? { data: [{ name: 'aviso_escalamiento', language: 'es_MX', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }, { name: 'confirmacion_reserva', language: 'es_MX', status: 'APPROVED', rejected_reason: 'NONE' }] }
        : { data: [{ name: 'confirmacion_reserva', language: 'es_MX' }] });
      if (req.url.startsWith('/api/v1/credentials')) return j({ id: 'cred' + llamadas.length });
      if (req.url.endsWith('/activate')) return j({ active: true });
      if (req.url.startsWith('/api/v1/workflows')) return j({ id: 'wf1' });
      j({ id: 'x', status: 'PENDING', success: true });
    });
  });
  return new Promise(ok => srv.listen(0, () => ok({ srv, llamadas, url: `http://127.0.0.1:${srv.address().port}` })));
}
const cli = (args, env) => run('node', [new URL('../scripts/cli.mjs', import.meta.url).pathname, ...args], { env: { PATH: process.env.PATH, ...env } }).catch(e => ({ stdout: e.stdout, stderr: e.stderr, code: e.code }));
const SECRETO = 'SECRETO-SUPER-LARGO-123';

test('CLI: sin --enviar es ensayo y no toca la red', async () => {
  const r = await cli(['aplicar', new URL('../clientes/arcosodi.json', import.meta.url).pathname], { SUPABASE_URL: 'http://127.0.0.1:1' });
  assert.match(r.stderr, /Corrige primero/);
  const f = '/tmp/cliente-completo.json'; fs.writeFileSync(f, JSON.stringify(completo));
  const ok = await cli(['aplicar', f], { SUPABASE_URL: 'http://127.0.0.1:1' });
  assert.match(ok.stdout, /ENSAYO/);
});

test('CLI --enviar: Supabase, Meta y n8n reciben lo correcto y los secretos no se imprimen', async () => {
  const { srv, llamadas, url } = await servidor();
  try {
    const f = '/tmp/cliente-completo.json'; fs.writeFileSync(f, JSON.stringify(completo));
    const env = { GRAPH_BASE: url, SUPABASE_URL: url, SUPABASE_SERVICE_KEY: SECRETO, N8N_URL: url, N8N_API_KEY: 'n8nkey', ANTHROPIC_API_KEY: 'sk-ant-xyz',
      META_WABA_ID: 'WABA1', META_TOKEN: 'metatoken', META_PHONE_NUMBER_ID: 'PID1', META_APP_ID: 'APP1', META_APP_SECRET: 'appsec', WEBHOOK_URL: 'https://n8n.example/webhook/p', WA_VERIFY_TOKEN: 'vt' };
    let salida = '';
    for (const a of [['aplicar', f], ['plantillas'], ['plantillas', '--estado'], ['webhook-meta'], ['probar', '5219511234567'], ['n8n']]) {
      const r = await cli([...a, ...(a[1] === '--estado' ? [] : ['--enviar'])], env);
      salida += (r.stdout || '') + (r.stderr || '');
    }
    for (const s of [SECRETO, 'metatoken', 'sk-ant-xyz', 'appsec', 'n8nkey']) assert.ok(!salida.includes(s), `se filtró el secreto ${s}`);
    const por = (m, re) => llamadas.filter(l => l.m === m && re.test(l.u));
    const canal = por('POST', /\/rest\/v1\/canales/)[0];
    assert.equal(canal.h.apikey, SECRETO); assert.equal(canal.b[0].phone_number_id, 'PID1'); assert.equal(canal.b[0].access_token, 'metatoken');
    assert.equal(por('POST', /\/rest\/v1\/respuestas_fijas/)[0].b.length, 4);
    const plantillas = por('POST', /WABA1\/message_templates$/).map(l => l.b.name).sort();
    assert.deepEqual(plantillas, ['aviso_escalamiento', 'aviso_escalamiento_en', 'confirmacion_reserva_en', 'nueva_solicitud_reserva', 'nueva_solicitud_reserva_en']);   // 'confirmacion_reserva' ya existía
    assert.match(salida, /aviso_escalamiento \[es_MX\] REJECTED — rechazo: INVALID_FORMAT/);
    assert.equal(por('POST', /APP1\/subscriptions/)[0].h.authorization, 'Bearer APP1|appsec');
    assert.equal(por('POST', /WABA1\/subscribed_apps/).length, 1);
    assert.equal(por('POST', /PID1\/messages/)[0].b.template.name, 'hello_world');
    assert.equal(por('POST', /\/api\/v1\/credentials/).length, 2);
    const wf = por('POST', /\/api\/v1\/workflows$/)[0].b;
    assert.equal(wf.nodes.find(n => n.name === 'Canal').credentials.httpCustomAuth.id.startsWith('cred'), true);
    assert.equal(por('POST', /wf1\/activate/).length, 1);
    assert.match(salida, /URL del webhook: .*\/webhook\/wa-/);
    const cred = por('POST', /\/api\/v1\/credentials/)[0].b;
    assert.deepEqual(JSON.parse(cred.data.json).headers, { apikey: SECRETO, Authorization: 'Bearer ' + SECRETO });
  } finally { srv.close(); }
});

test('flujo de n8n: estructura coherente y todos los nodos Code compilan', () => {
  const wf = buildWorkflow({ supabaseUrl: 'https://x.supabase.co', verifyToken: 'tok', path: 'p' });
  const nombres = wf.nodes.map(n => n.name);
  assert.equal(new Set(nombres).size, nombres.length, 'nombres repetidos');
  for (const [de, c] of Object.entries(wf.connections)) {
    assert.ok(nombres.includes(de), `origen desconocido ${de}`);
    for (const salida of c.main) for (const d of salida) assert.ok(nombres.includes(d.node), `destino desconocido ${d.node}`);
  }
  for (const n of wf.nodes.filter(n => n.type === 'n8n-nodes-base.if')) assert.ok((wf.connections[n.name]?.main.length ?? 0) >= 1, n.name);
  const codigos = wf.nodes.filter(n => n.type === 'n8n-nodes-base.code');
  assert.ok(codigos.length === 8);
  for (const n of codigos) assert.doesNotThrow(() => new vm.Script(`(async function(){${n.parameters.jsCode}\n})`), n.name);
  assert.match(wf.nodes.find(n => n.name === '¿Token correcto?').parameters.conditions.conditions[0].leftValue, /'tok'|"tok"/);
  // todo nodo alcanzable desde un webhook
  const vistos = new Set(), pila = nombres.filter(n => /Meta (verifica|envía)/.test(n));
  while (pila.length) { const n = pila.pop(); if (vistos.has(n)) continue; vistos.add(n); for (const s of wf.connections[n]?.main || []) for (const d of s) pila.push(d.node); }
  for (const n of nombres) if (n !== 'Leeme') assert.ok(vistos.has(n), `inalcanzable: ${n}`);
});

test('formulario: país, idioma y salud', () => {
  assert.match(validar({ ...completo, giro: 'banco' }).join(), /hotel o restaurante o citas/);
  assert.match(validar({ ...completo, pais: 'US', salud: 'si' }).join(), /BLOQUEADO.*HIPAA/);
  assert.deepEqual(validar({ ...completo, pais: 'MX', salud: 'si' }), []);                       // fuera de EE. UU. se permite…
  assert.match(avisos({ ...completo, pais: 'MX', salud: 'si' }).join(), /consentimiento/);        // …con aviso
  assert.match(avisos({ ...completo, pais: 'US' }).join(), /SMS/);
  assert.match(validar({ ...completo, pais: 'ES' }).join(), /País del negocio/);
  assert.match(validar({ ...completo, telefono_bot: '5551234' }).join(), /solo dígitos/);
  assert.deepEqual(validar({ ...completo, pais: 'US', estado: 'Texas', zona_horaria: 'America/Chicago', telefono_bot: '15551234567', dueno_telefono: '15557654321', idioma: 'en' }), []);
  assert.match(validar({ ...completo, pais: 'US', estado: 'Oaxaca' }).join(), /Estado.*Texas/);   // el estado debe ser del país
  assert.match(validar({ ...completo, estado: undefined }).join(), /Falta: Estado/);
  const f = filas({ ...completo, pais: 'US', idioma: 'en', salud: 'no' });
  assert.equal(f.cliente.salud, false); assert.equal(f.cliente.pais, 'US'); assert.ok(f.respuestas.every(r => r.idioma === 'en'));
});

test('traducción de respuestas: acepta lo fiel y descarta precios u enlaces cambiados', async () => {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const orig = JSON.parse(JSON.parse(b).messages[0].content);
      const out = { tarifas: orig.tarifas.replace('Tarifas por noche', 'Rates per night'), horarios: 'Check-in at 4 PM', ubicacion: orig.ubicacion.replace('https://www.google.com/maps/search/?api=1&query=C.+de+Mariano+Abasolo+514+Oaxaca', 'https://otro.example') };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
    });
  });
  await new Promise(r => srv.listen(0, r));
  const old = process.env.ANTHROPIC_URL; process.env.ANTHROPIC_URL = `http://127.0.0.1:${srv.address().port}/v1/messages`; process.env.ANTHROPIC_API_KEY = 'k';
  try {
    const out = await traducir({ ...completo, resp_horarios: 'Check-in 3 pm, check-out 12 pm.' });
    const por = Object.fromEntries(out.map(o => [o.clave, o]));
    assert.match(por.tarifas.texto, /^Rates per night/); assert.equal(por.tarifas.idioma, 'en');
    assert.equal(por.horarios, undefined, 'cambió la hora: se descarta');
    assert.equal(por.ubicacion, undefined, 'cambió el enlace: se descarta');
  } finally { srv.close(); if (old) process.env.ANTHROPIC_URL = old; else delete process.env.ANTHROPIC_URL; delete process.env.ANTHROPIC_API_KEY; }
});
