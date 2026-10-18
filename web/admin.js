// Todo el contenido llega de un formulario público: se pinta SIEMPRE con nodos de texto (nunca innerHTML).
const $ = (s, r = document) => r.querySelector(s);
const fecha = (x) => new Date(x).toLocaleString('es-MX');

function h(tag, props = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const hijo of hijos.flat(Infinity)) if (hijo != null && hijo !== false) el.append(hijo);
  return el;
}

async function api(ruta, { method = 'GET', body } = {}) {
  const r = await fetch('/admin/api' + ruta, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : 'Error ' + r.status);
  return d;
}

function aviso(msg, error = false) {
  const e = $('#aviso');
  e.textContent = msg; e.className = 'estado ' + (error ? 'error' : 'ok'); e.hidden = false;
}

async function accion(fn) {
  try { await fn(); } catch (e) { aviso(e.message, true); }
}

const insignia = (estado) => h('span', { class: 'insignia ' + estado }, estado);
const dato = (t, v) => (v ? [h('dt', {}, t), h('dd', {}, v)] : []);

// --- Solicitudes (fase 2) ---------------------------------------------------------------

let filtro = 'pendiente';

async function vistaSolicitudes() {
  const lista = h('ul', { class: 'lista' });
  const detalle = h('div', {}, h('p', { class: 'ayuda' }, 'Elige una solicitud.'));
  const selector = h('select', { 'aria-label': 'Filtrar por estado', onchange: (e) => { filtro = e.target.value; mostrar(); } },
    ['pendiente', 'aprobada', 'rechazada', ''].map((v) => h('option', { value: v, selected: v === filtro }, v || 'todas')));
  $('#vista').replaceChildren(h('div', { class: 'dos' }, h('div', {}, selector, lista), detalle));

  async function mostrar() {
    const filas = await api('/solicitudes' + (filtro ? '?estado=' + filtro : ''));
    lista.replaceChildren(...(filas.length ? filas.map((s) => h('li', {},
      h('button', { type: 'button', onclick: (e) => { lista.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-current')); e.currentTarget.setAttribute('aria-current', 'true'); accion(() => ver(s.id)); } },
        h('strong', {}, s.negocio), h('br'), `${s.sector} · ${fecha(s.creado_en)} `, insignia(s.estado))))
      : [h('li', { class: 'ayuda' }, 'Sin solicitudes.')]));
  }

  async function ver(id) {
    const s = await api('/solicitudes/' + id);
    const d = s.datos;
    const num = h('input', { id: 'num', inputmode: 'numeric', placeholder: 'Phone number ID de Meta (puedes dejarlo vacío)' });
    const motivo = h('input', { id: 'motivo', placeholder: 'Motivo del rechazo', maxlength: 500 });
    const acciones = s.estado === 'pendiente' ? h('div', { class: 'acciones' },
      h('div', {}, h('label', { for: 'num' }, 'Número de WhatsApp (opcional ahora)'), num),
      h('button', { type: 'button', class: 'primario', onclick: () => accion(async () => {
        if (!confirm(`¿Aprobar "${s.negocio}" y crear su bot?`)) return;
        const r = await api(`/solicitudes/${id}/aprobar`, { method: 'POST', body: { wa_phone_number_id: num.value.trim() || null } });
        aviso(`Aprobado. Bot creado (webhook: ${r.webhook}).` + (num.value.trim() ? '' : ' Falta vincular su número en Clientes.'));
        await mostrar(); await ver(id);
      }) }, 'Aprobar'),
      h('div', {}, h('label', { for: 'motivo' }, 'Rechazar con motivo'), motivo),
      h('button', { type: 'button', class: 'peligro', onclick: () => accion(async () => {
        await api(`/solicitudes/${id}/rechazar`, { method: 'POST', body: { motivo: motivo.value.trim() } });
        aviso('Solicitud rechazada.'); await mostrar(); await ver(id);
      }) }, 'Rechazar')) : null;

    detalle.replaceChildren(h('div', { class: 'tarjeta' },
      h('h2', {}, s.negocio, ' ', insignia(s.estado)),
      h('dl', {},
        dato('Sector', d.sector), dato('Descripción', d.descripcion),
        dato('Contacto', [d.contacto_nombre, d.contacto_email, d.contacto_telefono].filter(Boolean).join(' · ')),
        dato('Horarios', d.horarios), dato('Cobertura', d.cobertura), dato('Entrega', d.politica_entrega),
        dato('Bot', `${d.nombre_bot} · tono: ${d.tono}`), dato('Estilo', d.estilo),
        dato('Restricciones', d.restricciones), dato('Directrices', d.directrices),
        dato('Motivo de rechazo', s.motivo_rechazo)),
      h('h2', { class: 'separado' }, `Catálogo (${d.catalogo.length}, ${d.moneda})`),
      h('table', {}, h('thead', {}, h('tr', {}, ['Producto', 'Categoría', 'Precio', 'Detalle'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.catalogo.map((p) => h('tr', {},
          h('td', {}, p.nombre), h('td', {}, p.categoria), h('td', {}, p.precio ?? 'a consultar'),
          h('td', {}, [p.descripcion, p.variantes && 'Variantes: ' + p.variantes].filter(Boolean).join(' · ')))))),
      d.faqs.length ? [h('h2', { class: 'separado' }, 'Preguntas frecuentes'),
        h('dl', {}, d.faqs.map((q) => dato(q.pregunta, q.respuesta)))] : null,
      h('details', {}, h('summary', {}, 'Prompt que usará el bot'), h('pre', {}, s.prompt_preview)),
      acciones));
  }

  await mostrar();
}

// --- Clientes ---------------------------------------------------------------------------

async function vistaClientes() {
  const filas = await api('/clientes');
  $('#vista').replaceChildren(filas.length ? h('div', {}, filas.map((c) => {
    const num = h('input', { value: c.wa_phone_number_id ?? '', inputmode: 'numeric', 'aria-label': 'Phone number ID', placeholder: 'Sin número = bot apagado' });
    return h('div', { class: 'tarjeta' },
      h('h2', {}, c.nombre, ' ', h('span', { class: 'insignia ' + (c.wa_phone_number_id ? 'aprobada' : 'pendiente') }, c.wa_phone_number_id ? 'bot activo' : 'sin número')),
      h('p', { class: 'ayuda' }, `${c.sector} · ${c.mensajes} mensajes · creado ${fecha(c.creado_en)}`),
      h('div', { class: 'acciones' }, h('div', {}, num),
        h('button', { type: 'button', class: 'primario', onclick: () => accion(async () => {
          await api(`/clientes/${c.id}/numero`, { method: 'PUT', body: { wa_phone_number_id: num.value.trim() || null } });
          aviso(num.value.trim() ? 'Número vinculado: el bot ya responde.' : 'Bot apagado.'); vistaClientes();
        }) }, 'Guardar')));
  })) : h('p', { class: 'ayuda' }, 'Aún no hay clientes aprobados.'));
}

// --- Escalaciones -----------------------------------------------------------------------

async function vistaEscalaciones() {
  const filas = await api('/escalaciones');
  $('#vista').replaceChildren(filas.length ? h('div', {}, filas.map((e) => {
    const caja = h('div', { class: 'msgs' });
    return h('div', { class: 'tarjeta' },
      h('h2', {}, e.cliente, ' · ', e.nombre_perfil || e.telefono),
      h('p', { class: 'ayuda' }, `Tel. ${e.telefono} · ${fecha(e.escalada_en)}`),
      h('dl', {}, dato('Motivo', e.escalada_motivo), dato('Resumen', e.escalada_resumen)),
      h('div', { class: 'acciones' },
        h('button', { type: 'button', onclick: () => accion(async () => {
          const ms = await api(`/conversaciones/${e.id}/mensajes`);
          caja.replaceChildren(...ms.map((m) => h('p', { class: 'msg-' + m.direccion }, (m.direccion === 'in' ? 'Cliente: ' : 'Bot: ') + m.contenido)));
        }) }, 'Ver conversación'),
        h('button', { type: 'button', class: 'primario', onclick: () => accion(async () => {
          await api(`/conversaciones/${e.id}/atender`, { method: 'POST' });
          aviso('Marcada como atendida; el bot vuelve a responder.'); vistaEscalaciones();
        }) }, 'Marcar atendida')),
      caja);
  })) : h('p', { class: 'ayuda' }, 'Sin escalaciones pendientes.'));
}

// --- Navegación -------------------------------------------------------------------------

const vistas = { solicitudes: vistaSolicitudes, clientes: vistaClientes, escalaciones: vistaEscalaciones };
let actual = 'solicitudes';
let temporizador;

function ir(nombre) {
  actual = nombre;
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.vista === nombre)));
  $('#aviso').hidden = true;
  accion(vistas[nombre]);
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => ir(b.dataset.vista)));
// Las escalaciones son urgentes: se refrescan solas si no hay un mensaje abierto.
clearInterval(temporizador);
temporizador = setInterval(() => { if (actual === 'escalaciones' && !document.querySelector('.msgs p')) accion(vistaEscalaciones); }, 30000);
ir('solicitudes');
