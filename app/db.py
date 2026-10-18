"""Acceso a Postgres. Todo el SQL vive aquí; cada consulta de datos de cliente filtra por cliente_id."""
import json

import asyncpg

from . import config
from .prompt import construir_prompt

pool: asyncpg.Pool


class NoEncontrado(Exception):
    pass


class Conflicto(Exception):
    pass


async def _codecs(c):
    await c.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def init() -> None:
    global pool
    # statement_cache_size=0: compatible con el pooler de Supabase (modo transacción).
    pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=5, command_timeout=30,
                                     statement_cache_size=0, init=_codecs)


async def close() -> None:
    await pool.close()


async def salud() -> None:
    await pool.fetchval("select 1")


# --- solicitudes (fase 1 y 2) -------------------------------------------------------------

async def crear_solicitud(s: dict) -> str:
    return str(await pool.fetchval(
        """insert into solicitudes (negocio, sector, contacto_nombre, contacto_email, contacto_telefono, datos)
           values ($1, $2, $3, $4, $5, $6) returning id""",
        s["negocio"], s["sector"], s["contacto_nombre"], s.get("contacto_email"),
        s.get("contacto_telefono"), s))


async def listar_solicitudes(estado: str | None):
    return await pool.fetch(
        """select id, negocio, sector, estado, contacto_nombre, creado_en from solicitudes
           where ($1::text is null or estado = $1) order by creado_en desc limit 200""", estado)


async def solicitud(sid):
    r = await pool.fetchrow("select * from solicitudes where id = $1", sid)
    if r is None:
        raise NoEncontrado
    return r


# --- aprobación (fase 3): una sola transacción, sin dobles aprobaciones -------------------

async def aprobar(sid, numero: str | None) -> dict:
    async with pool.acquire() as c, c.transaction():
        s = await c.fetchrow("select * from solicitudes where id = $1 for update", sid)
        if s is None:
            raise NoEncontrado
        if s["estado"] != "pendiente":
            raise Conflicto(f"la solicitud ya está {s['estado']}")
        prompt = construir_prompt(s["datos"])
        try:
            cid = await c.fetchval(
                """insert into clientes (solicitud_id, nombre, sector, datos, prompt_sistema, wa_phone_number_id)
                   values ($1, $2, $3, $4, $5, $6) returning id""",
                sid, s["negocio"], s["sector"], s["datos"], prompt, numero)
        except asyncpg.UniqueViolationError:
            raise Conflicto("ese número de WhatsApp ya está vinculado a otro negocio") from None
        await c.execute("update solicitudes set estado = 'aprobada', resuelto_en = now() where id = $1", sid)
    return {"cliente_id": str(cid), "prompt_sistema": prompt, "datos": s["datos"]}


async def rechazar(sid, motivo: str) -> None:
    ok = await pool.fetchval(
        """update solicitudes set estado = 'rechazada', motivo_rechazo = $2, resuelto_en = now()
           where id = $1 and estado = 'pendiente' returning id""", sid, motivo)
    if ok is None:
        await solicitud(sid)  # lanza NoEncontrado si no existe
        raise Conflicto("la solicitud ya fue resuelta")


# --- clientes -----------------------------------------------------------------------------

async def listar_clientes():
    return await pool.fetch(
        """select c.id, c.nombre, c.sector, c.wa_phone_number_id, c.creado_en,
                  (select count(*) from mensajes m where m.cliente_id = c.id) as mensajes
           from clientes c order by c.creado_en desc""")


async def asignar_numero(cid, numero: str | None) -> None:
    try:
        ok = await pool.fetchval("update clientes set wa_phone_number_id = $2 where id = $1 returning id", cid, numero)
    except asyncpg.UniqueViolationError:
        raise Conflicto("ese número de WhatsApp ya está vinculado a otro negocio") from None
    if ok is None:
        raise NoEncontrado


# --- conversaciones (bot) -----------------------------------------------------------------

async def cliente_por_numero(phone_number_id: str):
    return await pool.fetchrow(
        "select id, nombre, prompt_sistema from clientes where wa_phone_number_id = $1", phone_number_id)


async def conversacion(cliente_id, telefono: str, nombre: str | None):
    return await pool.fetchrow(
        """insert into conversaciones (cliente_id, telefono, nombre_perfil) values ($1, $2, $3)
           on conflict (cliente_id, telefono)
           do update set nombre_perfil = coalesce(excluded.nombre_perfil, conversaciones.nombre_perfil)
           returning id, pausado_hasta""", cliente_id, telefono, nombre)


async def guardar_mensaje(cliente_id, conv_id, direccion: str, contenido: str, wa_id: str | None = None) -> bool:
    """False si wa_id ya existía (Meta reintentó la entrega)."""
    return await pool.fetchval(
        """insert into mensajes (cliente_id, conversacion_id, direccion, contenido, wa_message_id)
           values ($1, $2, $3, $4, $5) on conflict (wa_message_id) do nothing returning true""",
        cliente_id, conv_id, direccion, contenido, wa_id) is True


async def historial(cliente_id, conv_id, n: int):
    filas = await pool.fetch(
        """select direccion, contenido from mensajes where cliente_id = $1 and conversacion_id = $2
           order by creado_en desc, id desc limit $3""", cliente_id, conv_id, n)
    return list(reversed(filas))


async def mensajes_ultima_hora(cliente_id, conv_id) -> int:
    return await pool.fetchval(
        """select count(*) from mensajes where cliente_id = $1 and conversacion_id = $2
           and direccion = 'in' and creado_en > now() - interval '1 hour'""", cliente_id, conv_id)


async def escalar(cliente_id, conv_id, motivo: str, resumen: str, minutos: int) -> None:
    await pool.execute(
        """update conversaciones set pausado_hasta = now() + make_interval(mins => $5::int),
               escalada_en = now(), escalada_motivo = $3, escalada_resumen = $4, atendida_en = null
           where id = $2 and cliente_id = $1""", cliente_id, conv_id, motivo, resumen, minutos)


# --- escalaciones (panel) -----------------------------------------------------------------

async def escalaciones_pendientes():
    return await pool.fetch(
        """select v.id, c.nombre as cliente, v.telefono, v.nombre_perfil, v.escalada_en,
                  v.escalada_motivo, v.escalada_resumen
           from conversaciones v join clientes c on c.id = v.cliente_id
           where v.escalada_en is not null and v.atendida_en is null
           order by v.escalada_en desc limit 100""")


async def mensajes_de(conv_id):
    filas = await pool.fetch(
        """select direccion, contenido, creado_en from mensajes where conversacion_id = $1
           order by creado_en desc, id desc limit 30""", conv_id)
    return list(reversed(filas))


async def atender(conv_id) -> None:
    ok = await pool.fetchval(
        """update conversaciones set atendida_en = now(), pausado_hasta = null
           where id = $1 and escalada_en is not null returning id""", conv_id)
    if ok is None:
        raise NoEncontrado
