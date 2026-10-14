import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const bot = createRequire(import.meta.url)('../n8n/code/bot.cjs');

const AHORA = '2026-10-14T18:00:00Z';   // 14 oct 2026, 11:00 en Los Ángeles
const hotelUS = { nombre: 'Maple Inn', giro: 'hotel', zona_horaria: 'America/Los_Angeles', pais: 'US', idioma: 'en', dueno_nombre: 'Sam' };
const dental = { nombre: 'Bright Salon', giro: 'citas', zona_horaria: 'America/Chicago', pais: 'US', idioma: 'en', dueno_nombre: 'Maria', salud: false };
const R = { en: { tarifas: 'Rooms from $189 per night.', horarios: 'Check-in 3 PM, check-out 11 AM.', ubicacion: '12 Maple St, Portland.', servicios: 'Free parking and breakfast.' }, es: { tarifas: 'Habitaciones desde $189 por noche.', ubicacion: 'Calle Maple 12, Portland.' } };
let conv = {};
const say = (texto, extra = {}) => { const r = bot.decidir({ texto, ahora: AHORA, cliente: hotelUS, respuestas: R, conv, ...extra }); if (!r.needs_llm) conv = { borrador: r.borrador, intentos: r.intentos, idioma: r.idioma }; return r; };
const fresh = () => { conv = {}; };

test('fechas en inglés y formato de EE. UU.', () => {
  const f = (x, mdy = true) => bot.parseFechas(x, '2026-10-14', mdy);
  assert.deepEqual(f('Nov 20'), ['2026-11-20']);
  assert.deepEqual(f('November 20th, 2027'), ['2027-11-20']);
  assert.deepEqual(f('20 November'), ['2026-11-20']);
  assert.deepEqual(f('from Nov 12 to Nov 15'), ['2026-11-12', '2026-11-15']);
  assert.deepEqual(f('Nov 12 - 15'), ['2026-11-12', '2026-11-15']);
  assert.deepEqual(f('tomorrow'), ['2026-10-15']);
  assert.deepEqual(f('day after tomorrow'), ['2026-10-16']);
  assert.deepEqual(f('11/20'), ['2026-11-20']);               // mes/día en EE. UU.
  assert.deepEqual(f('20/11'), ['2026-11-20']);               // si no cuadra como mes/día, se lee día/mes
  assert.deepEqual(f('12/11'), ['2026-12-11']);               // EE. UU.: 11 de diciembre
  assert.deepEqual(f('12/11', false), ['2026-11-12']);        // México: 12 de noviembre
  assert.deepEqual(f('9 de la mañana'), []);                  // "mañana" de hora no es "tomorrow"
});

test('horas en inglés', () => {
  for (const [x, h] of [['3pm', '15:00'], ['at 3:30 p.m.', '15:30'], ['9 in the morning', '09:00'], ['noon', '12:00'], ['12am', '00:00'], ['8 de la noche', '20:00'], ['20:30', '20:30']]) assert.equal(bot.parseHora(x, false), h, x);
  assert.equal(bot.parseHora('Nov 20', false), null);
});

test('reserva de hotel completa en inglés', () => {
  fresh();
  let r = say('Hi, I want to book a room'); assert.match(r.reply, /What day do you arrive\?/); assert.equal(r.idioma, 'en');
  r = say('Nov 20'); assert.match(r.reply, /What day do you leave\?/);
  r = say('3 nights'); assert.match(r.reply, /How many guests\?/);
  r = say('two'); assert.match(r.reply, /What name should the request/);
  r = say('Sarah Johnson');
  assert.match(r.reply, /Please review your request/); assert.match(r.reply, /Arrival: Fri, Nov 20, 2026/); assert.match(r.reply, /Departure: Mon, Nov 23, 2026 \(3 nights\)/); assert.match(r.reply, /Guests: 2/);
  r = say('yes'); assert.equal(r.accion, 'reservar'); assert.equal(r.reserva.nombre, 'Sarah Johnson');
  const f = bot.finalizarReserva({ ok: true, folio: 'A1B2C3', cliente: hotelUS, nombre: 'Sarah', idioma: r.idioma });
  assert.match(f.reply, /reference A1B2C3/); assert.match(f.reply, /not a confirmed booking yet/);
  assert.match(bot.finalizarReserva({ ok: false, cliente: hotelUS, idioma: 'en' }).reply, /problem saving/);
});

test('todo en un mensaje, en inglés', () => {
  fresh();
  const r = say('I would like to book from Nov 12 to Nov 15 for 2 guests, my name is Tom Baker');
  assert.match(r.reply, /Please review your request/); assert.equal(r.borrador.datos.nombre, 'Tom Baker'); assert.equal(r.borrador.datos.personas, 2);
});

test('"3/4" es 4 de marzo en EE. UU. y 3 de abril en México', () => {
  fresh(); say('book a room'); let r = say('3/4/2027'); assert.equal(r.borrador.datos.llegada, '2027-03-04');
  conv = {}; const mx = { ...hotelUS, pais: 'MX' };
  let m = bot.decidir({ texto: 'quiero reservar', ahora: AHORA, cliente: mx, respuestas: R, conv: {} });
  m = bot.decidir({ texto: '3/4/2027', ahora: AHORA, cliente: mx, respuestas: R, conv: { borrador: m.borrador, idioma: m.idioma } });
  assert.equal(m.borrador.datos.llegada, '2027-04-03');
});

test('el idioma sigue al cliente, no al negocio', () => {
  fresh();
  let r = say('hola, cuánto cuesta?');
  assert.equal(r.idioma, 'es'); assert.match(r.reply, /desde \$189/);                  // respuesta fija en español
  r = say('2'); assert.equal(r.idioma, 'es');                                          // un "2" no cambia el idioma
  fresh(); r = say('how much is a room?'); assert.equal(r.idioma, 'en'); assert.match(r.reply, /from \$189/);
  r = say('where are you?'); assert.match(r.reply, /Maple St/);
});

test('si falta el texto en el idioma del cliente se usa el otro, y si no hay ninguno no inventa', () => {
  fresh();
  const r = say('hola, ¿qué servicios incluye?');             // no hay servicios en español → cae al inglés
  assert.match(r.reply, /Free parking/);
  fresh(); assert.match(say('what is your cancellation policy?').reply, /A person will confirm/);
});

test('menú en inglés, con saludo del negocio solo en su idioma', () => {
  fresh();
  let r = say('hello'); assert.match(r.reply, /^Hi, thanks for messaging Maple Inn\./); assert.match(r.reply, /1\. Book a room/); assert.match(r.reply, /5\. Talk to a person/);
  fresh(); r = bot.decidir({ texto: 'hola', ahora: AHORA, cliente: { ...hotelUS, saludo: 'Welcome to {nombre}!' }, respuestas: R, conv: {} });
  assert.match(r.reply, /^Hola, gracias por escribir a Maple Inn\./);            // el saludo personalizado está en inglés: no se usa con alguien que escribe en español
  r = bot.decidir({ texto: 'hello', ahora: AHORA, cliente: { ...hotelUS, saludo: 'Welcome to {nombre}!' }, respuestas: R, conv: {} });
  assert.match(r.reply, /^Welcome to Maple Inn!/);
});

test('escalamiento en inglés', () => {
  for (const x of ['I want to talk to a real person', 'let me speak to the manager', 'human', 'this is a scam, I want a refund', 'I was charged twice', 'emergency']) { fresh(); assert.equal(say(x).accion, 'escalar', x); }
  fresh(); assert.match(say('speak to a person').reply, /let Sam know/);
  fresh(); assert.notEqual(say('my name is Sue and I want a room').accion, 'escalar');
});

test('cancelar, sí/no y dudas a media solicitud, en inglés', () => {
  fresh(); say('book a room'); say('Nov 20');
  let r = say('do you have parking?'); assert.match(r.reply, /Free parking/); assert.match(r.reply, /Back to your request/); assert.match(r.reply, /What day do you leave/);
  r = say('never mind'); assert.equal(r.borrador, null); assert.match(r.reply, /cancelled/);
  fresh(); say('book Nov 20 to Nov 22 for 2 people, name is Ann'); r = say('no'); assert.deepEqual(r.borrador.datos, {}); assert.match(r.reply, /start over/);
  fresh(); say('book Nov 20 to Nov 22 for 2 people, name is Ann'); assert.match(say('maybe').reply, /Reply YES/);
});

test('fecha ambigua y fecha pasada, en inglés', () => {
  fresh(); say('book a room'); assert.match(say('this Friday').reply, /exact date/);
  assert.match(say('Oct 1').reply, /has already passed/);
});

test('giro "citas": fecha, hora, servicio y nombre', () => {
  const d = x => { const r = bot.decidir({ texto: x, ahora: AHORA, cliente: dental, respuestas: R, conv }); if (!r.needs_llm) conv = { borrador: r.borrador, idioma: r.idioma }; return r; };
  conv = {};
  assert.match(d('hi I need an appointment').reply, /What day works for you\?/);
  assert.match(d('tomorrow').reply, /What time\?/);
  assert.match(d('4:30pm').reply, /What service do you need\?/);
  assert.match(d('haircut and beard trim').reply, /What name should the appointment/);
  const r = d('Luis Pérez');
  assert.match(r.reply, /Date: Thu, Oct 15, 2026/); assert.match(r.reply, /Time: 4:30 PM/); assert.match(r.reply, /Service: haircut and beard trim/);
  const fin = d('yes'); assert.equal(fin.reserva.hora, '16:30'); assert.equal(fin.reserva.fecha_inicio, '2026-10-15'); assert.equal(fin.reserva.detalle.servicio, 'haircut and beard trim');
});

test('negocio de salud en un país donde se permite: el saludo pide no compartir datos médicos', () => {
  const r = bot.decidir({ texto: 'hola', ahora: AHORA, cliente: { ...dental, pais: 'MX', idioma: 'es', salud: true }, respuestas: R, conv: {} });
  assert.match(r.reply, /no compartas aquí información médica/);
  const e = bot.decidir({ texto: 'hello', ahora: AHORA, cliente: { ...dental, salud: true }, respuestas: R, conv: {} });
  assert.match(e.reply, /Please don't share medical information here\./);
});

test('la IA recibe los datos en los dos idiomas y la instrucción de responder en el del cliente', () => {
  const p = bot.promptLLM(hotelUS, R, 'do you allow dogs?');
  assert.match(p.system, /\(en\)/); assert.match(p.system, /\(es\)/); assert.match(p.system, /customer's language/);
  assert.equal(bot.leerLLM('{"intencion":"otro","resuelto":true,"respuesta":"See https://maple.example"}', R).resuelto, false);
});
