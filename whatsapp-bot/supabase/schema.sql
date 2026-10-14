-- Bot de WhatsApp multi-cliente. Un solo Supabase para todos los negocios; cada fila lleva su cliente_id.
-- n8n entra con la llave service_role y solo llama a las funciones bot_*. Las personas del negocio entran con su usuario
-- (tabla miembros) y la seguridad por filas (RLS) solo les deja ver lo de su negocio.

create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  giro text not null check (giro in ('hotel', 'restaurante', 'citas')),   -- citas: salón, barbería, taller, spa, etc.
  pais text not null default 'MX' check (pais in ('MX', 'US', 'OTRO')),
  idioma text not null default 'es' check (idioma in ('es', 'en')),      -- idioma en el que el negocio escribe sus respuestas
  salud boolean not null default false,                                   -- ¿maneja información de salud de pacientes?
  ciudad text,
  estado text,
  direccion text,
  zona_horaria text not null default 'America/Mexico_City',
  dueno_nombre text,
  dueno_telefono text not null,
  dueno_correo text,
  saludo text,
  pausa_min int not null default 30 check (pausa_min between 1 and 1440),
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  -- WhatsApp no sirve para información de salud en EE. UU. (Meta no firma BAA de HIPAA y su política lo restringe).
  -- Se bloquea aquí para que ni un error del formulario ni del script lo permita.
  constraint sin_salud_en_us check (not (pais = 'US' and salud))
);

-- Un número de WhatsApp por cliente. Guarda secretos: ninguna política los expone, solo service_role los lee.
create table if not exists canales (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  phone_number_id text not null unique,
  waba_id text,
  telefono text,
  access_token text,
  app_secret text,
  creado_en timestamptz not null default now()
);

create table if not exists respuestas_fijas (
  cliente_id uuid not null references clientes(id) on delete cascade,
  clave text not null check (clave in ('tarifas', 'horarios', 'ubicacion', 'servicios', 'politicas')),
  idioma text not null default 'es' check (idioma in ('es', 'en')),
  texto text not null,
  primary key (cliente_id, clave, idioma)
);

create table if not exists conversaciones (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  telefono text not null,
  nombre_perfil text,
  idioma text,
  estado text not null default 'activa' check (estado in ('activa', 'humano')),
  pausado_hasta timestamptz,
  borrador jsonb,
  intentos int not null default 0,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (cliente_id, telefono)
);

create table if not exists mensajes (
  id uuid primary key default gen_random_uuid(),
  conversacion_id uuid not null references conversaciones(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  wa_message_id text,
  direccion text not null check (direccion in ('in', 'out')),
  contenido text,
  intencion text,
  creado_en timestamptz not null default now()
);
create unique index if not exists mensajes_wa_unico on mensajes (cliente_id, wa_message_id) where wa_message_id is not null;
create index if not exists mensajes_conv on mensajes (conversacion_id, creado_en);

create table if not exists reservaciones (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  conversacion_id uuid references conversaciones(id) on delete set null,
  folio text not null unique,
  nombre text,
  telefono text not null,
  personas int,
  fecha_inicio date,
  fecha_fin date,
  hora time,
  detalle jsonb,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'confirmada', 'cancelada')),
  creado_en timestamptz not null default now()
);
create index if not exists reservaciones_cliente on reservaciones (cliente_id, creado_en desc);

-- Quién puede ver el panel de cada negocio (usuarios de Supabase Auth).
create table if not exists miembros (
  user_id uuid not null,
  cliente_id uuid not null references clientes(id) on delete cascade,
  primary key (user_id, cliente_id)
);

-- ---------- seguridad por filas ----------
alter table clientes enable row level security;
alter table canales enable row level security;           -- sin políticas: nadie con sesión de usuario la ve
alter table respuestas_fijas enable row level security;
alter table conversaciones enable row level security;
alter table mensajes enable row level security;
alter table reservaciones enable row level security;
alter table miembros enable row level security;

create or replace function mis_clientes() returns setof uuid language sql stable security definer set search_path = public as
$$ select cliente_id from miembros where user_id = auth.uid() $$;

create policy clientes_ver on clientes for select to authenticated using (id in (select mis_clientes()));
create policy miembros_ver on miembros for select to authenticated using (user_id = auth.uid());
create policy respuestas_todo on respuestas_fijas for all to authenticated
  using (cliente_id in (select mis_clientes())) with check (cliente_id in (select mis_clientes()));
create policy conversaciones_ver on conversaciones for select to authenticated using (cliente_id in (select mis_clientes()));
create policy conversaciones_reanudar on conversaciones for update to authenticated
  using (cliente_id in (select mis_clientes())) with check (cliente_id in (select mis_clientes()));
create policy mensajes_ver on mensajes for select to authenticated using (cliente_id in (select mis_clientes()));
create policy reservaciones_ver on reservaciones for select to authenticated using (cliente_id in (select mis_clientes()));
create policy reservaciones_estado on reservaciones for update to authenticated
  using (cliente_id in (select mis_clientes())) with check (cliente_id in (select mis_clientes()));

-- ---------- funciones que usa n8n (solo service_role) ----------

-- Paso 1: datos del canal para validar la firma de Meta antes de guardar nada.
create or replace function bot_canal(p_phone_number_id text) returns jsonb language sql security definer set search_path = public as
$$ select coalesce(
     (select jsonb_build_object('ok', true, 'app_secret', ca.app_secret) from canales ca join clientes c on c.id = ca.cliente_id
       where ca.phone_number_id = p_phone_number_id and c.activo),
     jsonb_build_object('ok', false)) $$;

-- Paso 2: registra el mensaje entrante y devuelve todo lo que el bot necesita para contestar.
create or replace function bot_contexto(p_phone_number_id text, p_from text, p_wa_id text, p_texto text, p_nombre text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_canal canales; v_cli clientes; v_conv conversaciones; v_id uuid; v_nueva boolean; v_ins int; v_pausado boolean;
begin
  select * into v_canal from canales where phone_number_id = p_phone_number_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'canal_desconocido'); end if;
  select * into v_cli from clientes where id = v_canal.cliente_id and activo;
  if not found then return jsonb_build_object('ok', false, 'error', 'cliente_inactivo'); end if;

  insert into conversaciones (cliente_id, telefono, nombre_perfil) values (v_cli.id, p_from, p_nombre)
  on conflict (cliente_id, telefono) do update set actualizado_en = now(), nombre_perfil = coalesce(excluded.nombre_perfil, conversaciones.nombre_perfil)
  returning id, (xmax = 0) into v_id, v_nueva;
  select * into v_conv from conversaciones where id = v_id;

  insert into mensajes (conversacion_id, cliente_id, wa_message_id, direccion, contenido) values (v_conv.id, v_cli.id, p_wa_id, 'in', p_texto)
  on conflict (cliente_id, wa_message_id) where wa_message_id is not null do nothing;
  get diagnostics v_ins = row_count;
  if v_ins = 0 then return jsonb_build_object('ok', true, 'duplicado', true); end if;   -- Meta reenvía webhooks: se ignora el repetido

  v_pausado := v_conv.estado = 'humano' and v_conv.pausado_hasta is not null and v_conv.pausado_hasta > now();
  if v_conv.estado = 'humano' and not v_pausado then
    update conversaciones set estado = 'activa', pausado_hasta = null where id = v_conv.id;
    v_conv.estado := 'activa';
  end if;

  return jsonb_build_object(
    'ok', true, 'duplicado', false, 'pausado', v_pausado, 'es_nueva', v_nueva,
    'canal', jsonb_build_object('phone_number_id', v_canal.phone_number_id, 'access_token', v_canal.access_token),
    'cliente', jsonb_build_object('id', v_cli.id, 'nombre', v_cli.nombre, 'giro', v_cli.giro, 'zona_horaria', v_cli.zona_horaria,
       'dueno_nombre', v_cli.dueno_nombre, 'dueno_telefono', v_cli.dueno_telefono, 'saludo', v_cli.saludo, 'pausa_min', v_cli.pausa_min,
       'pais', v_cli.pais, 'idioma', v_cli.idioma, 'salud', v_cli.salud),
    'conv', jsonb_build_object('id', v_conv.id, 'borrador', v_conv.borrador, 'intentos', v_conv.intentos, 'idioma', v_conv.idioma),
    'respuestas', coalesce((select jsonb_object_agg(idioma, o) from (select idioma, jsonb_object_agg(clave, texto) o from respuestas_fijas where cliente_id = v_cli.id group by idioma) x), '{}'::jsonb));
end $$;

-- Paso 3: guarda lo que contestó el bot, el borrador de la reserva y si entró una persona.
create or replace function bot_responder(p_conv uuid, p_texto text, p_intencion text, p_borrador jsonb, p_intentos int, p_humano boolean, p_idioma text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_cli clientes; v_conv conversaciones;
begin
  select * into v_conv from conversaciones where id = p_conv;
  if not found then return; end if;
  select * into v_cli from clientes where id = v_conv.cliente_id;
  insert into mensajes (conversacion_id, cliente_id, direccion, contenido, intencion) values (v_conv.id, v_conv.cliente_id, 'out', p_texto, p_intencion);
  update conversaciones set borrador = p_borrador, intentos = coalesce(p_intentos, 0), actualizado_en = now(), idioma = coalesce(p_idioma, idioma),
    estado = case when p_humano then 'humano' else 'activa' end,
    pausado_hasta = case when p_humano then now() + make_interval(mins => v_cli.pausa_min) else null end
  where id = v_conv.id;
end $$;

-- Guarda la solicitud de reserva. Si el mismo cliente confirma dos veces seguidas, devuelve el mismo folio.
create or replace function bot_reservar(p_conv uuid, p_nombre text, p_personas int, p_inicio date, p_fin date, p_hora time, p_detalle jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_conv conversaciones; v_folio text; v_previo reservaciones;
begin
  select * into v_conv from conversaciones where id = p_conv;
  if not found then return jsonb_build_object('ok', false, 'error', 'conversacion'); end if;
  select * into v_previo from reservaciones where conversacion_id = v_conv.id and fecha_inicio is not distinct from p_inicio
    and fecha_fin is not distinct from p_fin and creado_en > now() - interval '5 minutes' order by creado_en desc limit 1;
  if found then return jsonb_build_object('ok', true, 'folio', v_previo.folio, 'repetida', true); end if;
  for i in 1..5 loop
    v_folio := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      insert into reservaciones (cliente_id, conversacion_id, folio, nombre, telefono, personas, fecha_inicio, fecha_fin, hora, detalle)
      values (v_conv.cliente_id, v_conv.id, v_folio, p_nombre, v_conv.telefono, p_personas, p_inicio, p_fin, p_hora, p_detalle);
      return jsonb_build_object('ok', true, 'folio', v_folio);
    exception when unique_violation then null;   -- folio repetido: se intenta con otro
    end;
  end loop;
  return jsonb_build_object('ok', false, 'error', 'folio');
exception when others then
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end $$;

revoke all on function bot_canal(text), bot_contexto(text, text, text, text, text), bot_responder(uuid, text, text, jsonb, int, boolean, text),
  bot_reservar(uuid, text, int, date, date, time, jsonb) from public, anon, authenticated;
grant execute on function bot_canal(text), bot_contexto(text, text, text, text, text), bot_responder(uuid, text, text, jsonb, int, boolean, text),
  bot_reservar(uuid, text, int, date, date, time, jsonb) to service_role;
