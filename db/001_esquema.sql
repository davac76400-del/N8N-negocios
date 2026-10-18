-- 001_esquema.sql — esquema inicial del ecosistema de bots de WhatsApp.
-- Idempotente: se puede correr varias veces. Reversa: 001_down.sql.
--
-- Seguridad: RLS activo en TODAS las tablas y sin políticas => los roles anon y
-- authenticated de Supabase no leen ni escriben nada. Solo el backend (conexión
-- directa a Postgres) accede, y filtra siempre por cliente_id.

-- Solicitudes del formulario público (todavía no son tenants).
create table if not exists solicitudes (
  id                uuid primary key default gen_random_uuid(),
  estado            text not null default 'pendiente'
                    check (estado in ('pendiente', 'aprobada', 'rechazada')),
  negocio           text not null,
  sector            text not null,
  contacto_nombre   text not null,
  contacto_email    text,
  contacto_telefono text,
  datos             jsonb not null,          -- cuestionario completo (negocio, catálogo, reglas, personalidad)
  motivo_rechazo    text,
  creado_en         timestamptz not null default now(),
  resuelto_en       timestamptz
);
create index if not exists solicitudes_estado_idx on solicitudes (estado, creado_en desc);

-- Un cliente = un negocio aprobado = un bot. Es la raíz del multi-tenant.
create table if not exists clientes (
  id                 uuid primary key default gen_random_uuid(),
  solicitud_id       uuid not null unique references solicitudes(id),
  nombre             text not null,
  sector             text not null,
  datos              jsonb not null,         -- cuestionario aprobado (incluye el catálogo)
  prompt_sistema     text not null,          -- prompt generado al aprobar: es el "bot" del negocio
  wa_phone_number_id text unique,            -- ID del número en Meta; NULL = bot apagado
  creado_en          timestamptz not null default now()
);

create table if not exists conversaciones (
  id               uuid primary key default gen_random_uuid(),
  cliente_id       uuid not null references clientes(id) on delete cascade,
  telefono         text not null,            -- wa_id del cliente final
  nombre_perfil    text,
  pausado_hasta    timestamptz,              -- bot en silencio mientras un humano atiende
  escalada_en      timestamptz,
  escalada_motivo  text,
  escalada_resumen text,
  atendida_en      timestamptz,
  creado_en        timestamptz not null default now(),
  unique (cliente_id, telefono)
);
create index if not exists conversaciones_pendientes_idx
  on conversaciones (escalada_en desc)
  where escalada_en is not null and atendida_en is null;

create table if not exists mensajes (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references clientes(id) on delete cascade,
  conversacion_id uuid not null references conversaciones(id) on delete cascade,
  direccion       text not null check (direccion in ('in', 'out')),
  contenido       text not null,
  wa_message_id   text unique,               -- idempotencia: Meta reintenta entregas
  creado_en       timestamptz not null default now()
);
create index if not exists mensajes_conv_idx on mensajes (conversacion_id, creado_en desc);
create index if not exists mensajes_cliente_idx on mensajes (cliente_id);

alter table solicitudes    enable row level security;
alter table clientes       enable row level security;
alter table conversaciones enable row level security;
alter table mensajes       enable row level security;

-- Supabase da permisos por defecto a anon/authenticated; se quitan explícitamente.
-- (En un Postgres vanilla esos roles no existen y el bloque no hace nada.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on solicitudes, clientes, conversaciones, mensajes from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on solicitudes, clientes, conversaciones, mensajes from authenticated;
  end if;
end $$;

-- Retención (ley de protección de datos): borrar mensajes de más de 12 meses.
-- Programar con pg_cron o a mano:
--   delete from mensajes where creado_en < now() - interval '12 months';
