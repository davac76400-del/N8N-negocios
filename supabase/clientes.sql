-- Tabla de clientes del chatbot. Segura de re-ejecutar.
create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  email text,
  instance_id text unique not null,
  system_prompt text not null,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.clientes add column if not exists metadata jsonb not null default '{}'::jsonb;
-- RLS activo y SIN política para anon: la llave publishable no puede leer prompts ni datos.
-- n8n debe usar la llave service_role (credencial de n8n, nunca en el repo).
alter table public.clientes enable row level security;

insert into public.clientes (nombre, email, instance_id, system_prompt, status, metadata)
values (
  'Aura Dynamics',
  'cliente@auradynamics.com',
  'aura_dynamics',
  'Eres AuraAI, el asistente virtual oficial de Aura Dynamics. Tu objetivo es brindar atención al cliente de alto nivel, resolver dudas sobre nuestros servicios tecnológicos, calificar prospectos y agendar citas de negocios con un tono profesional, ágil, empático y enfocado en la conversión.',
  'pending',
  '{"sector":"Tech & Automation","language":"es","plan":"Enterprise","theme":"Dark","brand_color":"#6366F1","logo_url":"https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&q=80"}'::jsonb
)
on conflict (instance_id) do update
  set nombre = excluded.nombre, system_prompt = excluded.system_prompt, metadata = excluded.metadata;
