const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const texto = (id) => $('#' + id).value.trim();

function campo(clase, etiqueta, attrs = {}) {
  const l = document.createElement('label');
  l.textContent = etiqueta;
  const i = document.createElement(attrs.tag || 'input');
  i.dataset.k = clase;
  for (const [k, v] of Object.entries(attrs)) if (k !== 'tag') i.setAttribute(k, v);
  l.append(i);
  return l;
}

function fila(clase, campos) {
  const f = document.createElement('div');
  f.className = 'fila ' + clase;
  campos.forEach((c) => f.append(c));
  const q = document.createElement('button');
  q.type = 'button'; q.className = 'quitar'; q.textContent = 'Quitar';
  q.addEventListener('click', () => f.remove());
  f.append(q);
  return f;
}

function nuevoProducto() {
  const f = fila('producto', [
    campo('nombre', 'Nombre', { maxlength: 120 }),
    campo('categoria', 'Categoría (opcional)', { maxlength: 80 }),
    campo('precio', 'Precio (opcional)', { type: 'number', min: 0, step: '0.01' }),
    campo('descripcion', 'Descripción', { maxlength: 500 }),
    campo('variantes', 'Variantes (opcional)', { maxlength: 300 }),
  ]);
  f.children[3].classList.add('ancho');
  f.children[4].classList.add('ancho');
  $('#catalogo').append(f);
}

function nuevaFaq() {
  $('#faqs').append(fila('faq', [
    campo('pregunta', 'Pregunta', { maxlength: 300 }),
    campo('respuesta', 'Respuesta', { tag: 'textarea', maxlength: 1000 }),
  ]));
}

const dato = (f, k) => $(`[data-k="${k}"]`, f).value.trim();

function recolectar() {
  const catalogo = $$('#catalogo .fila').map((f) => ({
    nombre: dato(f, 'nombre'), categoria: dato(f, 'categoria'), descripcion: dato(f, 'descripcion'),
    variantes: dato(f, 'variantes'), precio: dato(f, 'precio') === '' ? null : Number(dato(f, 'precio')),
  })).filter((p) => p.nombre);
  const faqs = $$('#faqs .fila').map((f) => ({ pregunta: dato(f, 'pregunta'), respuesta: dato(f, 'respuesta') }))
    .filter((q) => q.pregunta && q.respuesta);
  const o = (id) => texto(id) || null;
  return {
    negocio: texto('negocio'), sector: texto('sector'), descripcion: texto('descripcion'), moneda: texto('moneda'),
    catalogo, horarios: texto('horarios'), cobertura: texto('cobertura'), politica_entrega: texto('politica_entrega'),
    faqs, nombre_bot: texto('nombre_bot') || 'Asistente', tono: texto('tono'), estilo: texto('estilo'),
    restricciones: texto('restricciones'), directrices: texto('directrices'),
    contacto_nombre: texto('contacto_nombre'), contacto_email: o('contacto_email'),
    contacto_telefono: o('contacto_telefono'), website: texto('website'),
    aviso_privacidad: $('#aviso_privacidad').checked,
  };
}

function mostrar(msg, clase) {
  const e = $('#estado');
  e.textContent = msg; e.className = 'estado ' + clase; e.hidden = false;
  e.scrollIntoView({ block: 'nearest' });
}

const ETIQUETAS = {
  negocio: 'Nombre comercial', sector: 'Sector', catalogo: 'Catálogo (al menos un producto con nombre)',
  horarios: 'Horarios de atención', tono: 'Tono', contacto_nombre: 'Tu nombre', contacto_email: 'Correo',
  contacto_telefono: 'Teléfono', moneda: 'Moneda', nombre_bot: 'Nombre del bot', faqs: 'Preguntas frecuentes',
};

function errores(detail) {
  if (!Array.isArray(detail)) return 'No pudimos guardar tu solicitud. Intenta de nuevo.';
  if (detail.some((d) => /aviso/.test(d.msg))) return 'Acepta el aviso de privacidad para enviar tu solicitud.';
  const campos = new Set(detail.map((d) => ETIQUETAS[d.loc[1]] || d.loc[1] || 'Solicitud'));
  const sinContacto = detail.some((d) => /contacto/.test(d.msg));
  return 'Revisa: ' + [...campos].join(', ') + (sinContacto ? '. Indica un correo o un teléfono.' : '. Faltan datos o hay textos demasiado cortos o largos.');
}

$('#mas-producto').addEventListener('click', nuevoProducto);
$('#mas-faq').addEventListener('click', nuevaFaq);
nuevoProducto();

$('#forma').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#enviar');
  btn.disabled = true;
  try {
    const r = await fetch('/api/solicitudes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(recolectar()),
    });
    if (r.status === 201) {
      $('#forma').reset();
      $$('#catalogo .fila, #faqs .fila').forEach((f) => f.remove());
      nuevoProducto();
      mostrar('¡Listo! Recibimos tu solicitud. Te contactaremos pronto.', 'ok');
    } else {
      const d = await r.json().catch(() => ({}));
      mostrar(errores(d.detail), 'error');
    }
  } catch {
    mostrar('No hay conexión. Intenta de nuevo.', 'error');
  } finally {
    btn.disabled = false;
  }
});
