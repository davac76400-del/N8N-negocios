// Prueba la base de datos de verdad (Postgres en memoria): aislamiento entre negocios, RPCs y permisos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const UA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', UB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`);
await db.exec(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated, service_role;`);
await db.exec(`
  insert into clientes (id, nombre, giro, dueno_nombre, dueno_telefono, pausa_min) values
    ('${A}', 'Hotel A', 'hotel', 'Lucía', '5219510000001', 30), ('${B}', 'Restaurante B', 'restaurante', 'Pedro', '5219510000002', 30);
  insert into canales (cliente_id, phone_number_id, access_token, app_secret) values ('${A}', 'PID_A', 'TOKEN_A', 'SECRET_A'), ('${B}', 'PID_B', 'TOKEN_B', 'SECRET_B');
  insert into respuestas_fijas (cliente_id, clave, idioma, texto) values ('${A}', 'tarifas', 'es', 'Tarifa A'), ('${A}', 'tarifas', 'en', 'Rate A'), ('${B}', 'tarifas', 'es', 'Tarifa B');
  insert into miembros values ('${UA}', '${A}'), ('${UB}', '${B}');
`);

const como = async (rol, sub, sql) => {
  await db.exec(`set role ${rol}; select set_config('request.jwt.sub', '${sub || ''}', false);`);
  try { return await db.query(sql); } finally { await db.exec('reset role;'); }
};
const rpc = async (fn, args) => {
  await db.exec('set role service_role;');
  try { return (await db.query(`select ${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as r`, args)).rows[0].r; } finally { await db.exec('reset role;'); }
};
const ctx = (pid, from, wa, texto = 'hola') => rpc('bot_contexto', [pid, from, wa, texto, 'Ana']);

test('canal desconocido o cliente inactivo no entra', async () => {
  assert.equal((await rpc('bot_canal', ['NOPE'])).ok, false);
  assert.equal((await rpc('bot_canal', ['PID_A'])).app_secret, 'SECRET_A');
  assert.equal((await ctx('NOPE', '521', 'w0')).error, 'canal_desconocido');
});

test('mensaje nuevo crea la conversación y devuelve solo datos de ese negocio', async () => {
  const r = await ctx('PID_A', '5219511111111', 'wamid.1', 'hola');
  assert.equal(r.ok, true); assert.equal(r.es_nueva, true); assert.equal(r.duplicado, false);
  assert.equal(r.cliente.nombre, 'Hotel A'); assert.deepEqual(r.respuestas, { es: { tarifas: 'Tarifa A' }, en: { tarifas: 'Rate A' } }); assert.equal(r.cliente.idioma, 'es'); assert.equal(r.cliente.pais, 'MX');
  assert.equal(r.canal.access_token, 'TOKEN_A');
  const r2 = await ctx('PID_A', '5219511111111', 'wamid.2');
  assert.equal(r2.es_nueva, false);
});

test('Meta reenvía el mismo webhook: se ignora', async () => {
  assert.equal((await ctx('PID_A', '5219511111111', 'wamid.2')).duplicado, true);
  const n = (await db.query(`select count(*)::int as n from mensajes where wa_message_id = 'wamid.2'`)).rows[0].n;
  assert.equal(n, 1);
});

test('el mismo wa_message_id en dos negocios no choca', async () => {
  assert.equal((await ctx('PID_B', '5219512222222', 'wamid.2')).duplicado, false);
});

test('responder guarda el borrador y escalar pausa la conversación; después de la pausa reanuda', async () => {
  const c = await ctx('PID_A', '5219513333333', 'wamid.10');
  await rpc('bot_responder', [c.conv.id, 'Entiendo, ya avisé', 'escalar', null, 0, true, 'es']);
  const p = await ctx('PID_A', '5219513333333', 'wamid.11');
  assert.equal(p.pausado, true);
  await db.exec(`update conversaciones set pausado_hasta = now() - interval '1 minute' where id = '${c.conv.id}'`);
  const q = await ctx('PID_A', '5219513333333', 'wamid.12');
  assert.equal(q.pausado, false);
  await rpc('bot_responder', [c.conv.id, 'pregunta', 'reservar', JSON.stringify({ activo: true, datos: { llegada: '2026-11-20' } }), 1, false, 'en']);
  const s = await ctx('PID_A', '5219513333333', 'wamid.13');
  assert.equal(s.conv.borrador.datos.llegada, '2026-11-20'); assert.equal(s.conv.intentos, 1); assert.equal(s.conv.idioma, 'en');
});

test('reservar guarda la solicitud con folio y es idempotente', async () => {
  const c = await ctx('PID_A', '5219514444444', 'wamid.20');
  const a = await rpc('bot_reservar', [c.conv.id, 'Ana', 2, '2026-11-20', '2026-11-23', null, JSON.stringify({ llegada: '2026-11-20' })]);
  assert.equal(a.ok, true); assert.match(a.folio, /^[0-9A-F]{6}$/);
  const b = await rpc('bot_reservar', [c.conv.id, 'Ana', 2, '2026-11-20', '2026-11-23', null, '{}']);
  assert.equal(b.folio, a.folio); assert.equal(b.repetida, true);
  const fila = (await db.query(`select estado, telefono, cliente_id from reservaciones where folio = $1`, [a.folio])).rows[0];
  assert.deepEqual(fila, { estado: 'pendiente', telefono: '5219514444444', cliente_id: A });
});

test('reservar con una conversación inexistente falla limpio (el bot no confirma)', async () => {
  const r = await rpc('bot_reservar', ['99999999-9999-9999-9999-999999999999', 'X', 1, '2026-11-20', null, null, '{}']);
  assert.equal(r.ok, false);
});

test('AISLAMIENTO: cada usuario solo ve su negocio', async () => {
  const cb = await ctx('PID_B', '5219515555555', 'wamid.30');
  await rpc('bot_reservar', [cb.conv.id, 'Luis', 4, '2026-11-20', null, '20:30', '{}']);
  for (const [sub, propio, ajeno] of [[UA, A, B], [UB, B, A]]) {
    for (const t of ['clientes', 'respuestas_fijas', 'conversaciones', 'mensajes', 'reservaciones']) {
      const col = t === 'clientes' ? 'id' : 'cliente_id';
      const mio = (await como('authenticated', sub, `select count(*)::int as n from ${t} where ${col} = '${propio}'`)).rows[0].n;
      const otro = (await como('authenticated', sub, `select count(*)::int as n from ${t} where ${col} = '${ajeno}'`)).rows[0].n;
      assert.ok(mio > 0, `${t}: ${sub} debe ver lo suyo`);
      assert.equal(otro, 0, `${t}: ${sub} NO debe ver lo del otro negocio`);
    }
  }
});

test('AISLAMIENTO: no se puede escribir ni mover cosas de otro negocio', async () => {
  await assert.rejects(como('authenticated', UA, `insert into respuestas_fijas values ('${B}', 'horarios', 'hackeado')`));
  const r = await como('authenticated', UA, `update reservaciones set estado = 'cancelada' where cliente_id = '${B}' returning id`);
  assert.equal(r.rows.length, 0);
  const folio = (await db.query(`select id from reservaciones where cliente_id = '${A}' limit 1`)).rows[0].id;
  assert.equal((await como('authenticated', UA, `update reservaciones set estado = 'confirmada' where id = '${folio}' returning id`)).rows.length, 1);
});

test('SECRETOS: ni usuarios ni anon leen los tokens', async () => {
  await assert.rejects(como('anon', '', 'select * from canales'));
  const r = await como('authenticated', UA, 'select * from canales');
  assert.equal(r.rows.length, 0);
});

test('PERMISOS: las funciones del bot solo las ejecuta service_role', async () => {
  for (const rol of ['anon', 'authenticated']) {
    await assert.rejects(como(rol, UA, `select bot_canal('PID_A')`));
    await assert.rejects(como(rol, UA, `select bot_contexto('PID_A','1','w','x','y')`));
  }
});

test('un usuario sin negocio no ve nada', async () => {
  const r = await como('authenticated', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'select * from reservaciones');
  assert.equal(r.rows.length, 0);
});

test('SALUD EN EE. UU.: la base se niega a crear un negocio de salud que use WhatsApp en Estados Unidos', async () => {
  await assert.rejects(db.query(`insert into clientes (nombre, giro, pais, salud, dueno_telefono) values ('Dental US', 'citas', 'US', true, '15550000000')`), /sin_salud_en_us/);
  await db.query(`insert into clientes (nombre, giro, pais, salud, dueno_telefono) values ('Clínica MX', 'citas', 'MX', true, '529510000000')`);   // fuera de EE. UU. se permite (con avisos)
  await db.query(`insert into clientes (nombre, giro, pais, salud, dueno_telefono) values ('Salon US', 'citas', 'US', false, '15550000001')`);
  await assert.rejects(db.query(`update clientes set salud = true where nombre = 'Salon US'`), /sin_salud_en_us/);
});
