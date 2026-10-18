-- 002_mensualidad.sql — permite pausar el bot de un negocio que no está al día con su mensualidad.
-- Idempotente. Reversa: alter table clientes drop column activo;
alter table clientes add column if not exists activo boolean not null default true;
