"""Motor conversacional multi-negocio: un solo proceso atiende a todos los clientes.

El "bot" de cada negocio es su prompt_sistema (generado al aprobar). El estado vive en Postgres,
así que reiniciar el contenedor no pierde conversaciones.
"""
import asyncio
import logging
import re
from collections import defaultdict
from datetime import datetime, timezone
from functools import cache
from zoneinfo import ZoneInfo

import anthropic

from . import config, db, events, whatsapp

log = logging.getLogger("bot")

# ponytail: locks en memoria => un solo worker de uvicorn. Con varios, usar pg_advisory_xact_lock.
_locks: defaultdict = defaultdict(asyncio.Lock)

DIAS = ("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo")

# Red de seguridad que no depende del LLM: temas que SIEMPRE van a una persona.
ESCALAR = re.compile(
    r"\b(humano|asesor|gerente|encargad[oa]|due[ñn][oa]|queja|reclam\w*|al[eé]rg\w*|intoxic\w*|"
    r"reembols\w*|devoluci[oó]n|cobro indebido|demanda|profeco|abogad[oa]|hablar con (una |un )?(persona|alguien))\b",
    re.IGNORECASE)

TE_PASO = "Entendido. Ya avisé a una persona del equipo para que te atienda; te escribirá en breve. 🙏"
FALLO_IA = "Tuve un problema técnico para responderte. Ya avisé a una persona del equipo para que te atienda."
SIN_RESPUESTA = "Disculpa, no logré entenderte. ¿Me lo puedes explicar de otra forma?"
SOLO_TEXTO = "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribes, por favor?"

# Modelos que aceptan el parámetro server-side `fallbacks` (si un clasificador de seguridad
# rechaza una petición legítima, se reintenta en otro modelo en vez de devolver el rechazo).
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"}

PASAR_A_HUMANO = {
    "name": "pasar_a_humano",
    "description": ("Transfiere la conversación a una persona del equipo y silencia al bot. Úsala para quejas, "
                    "temas sensibles, cuando el cliente pida un humano o cuando un pedido/reserva esté listo "
                    "para que el equipo lo confirme."),
    "input_schema": {
        "type": "object",
        "properties": {
            "motivo": {"type": "string", "description": "Motivo en una frase corta."},
            "resumen": {"type": "string", "description": (
                "Resumen para el equipo: qué quiere el cliente y los datos reunidos "
                "(productos, cantidades, nombre, dirección, fecha).")},
        },
        "required": ["motivo", "resumen"],
    },
}


@cache
def _cliente_llm() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(timeout=45.0, max_retries=2)


def _a_mensajes(filas) -> list[dict]:
    msgs = [{"role": "user" if f["direccion"] == "in" else "assistant", "content": f["contenido"]} for f in filas]
    while msgs and msgs[0]["role"] == "assistant":  # la API exige empezar con un turno de usuario
        msgs.pop(0)
    return msgs


async def pedir_respuesta(prompt_negocio: str, historial: list[dict]) -> tuple[str, dict | None]:
    """Devuelve (texto para el cliente, datos de escalación o None)."""
    ahora = datetime.now(ZoneInfo(config.ZONA_HORARIA))
    kw = dict(
        model=config.CLAUDE_MODEL,
        max_tokens=1500,
        output_config={"effort": "low"},  # chat corto: baja latencia y costo
        # El prompt del negocio va primero y cacheado; la hora (volátil) va después del breakpoint.
        system=[
            {"type": "text", "text": prompt_negocio, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": f"Fecha y hora actual del negocio: {DIAS[ahora.weekday()]} "
                                     f"{ahora:%d/%m/%Y %H:%M} ({config.ZONA_HORARIA})."},
        ],
        tools=[PASAR_A_HUMANO],
        messages=historial,
    )
    c = _cliente_llm()
    if config.CLAUDE_MODEL in FALLBACK_MODELS:
        r = await c.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kw)
    else:
        r = await c.messages.create(**kw)

    if r.stop_reason == "refusal":
        return "", {"motivo": "El modelo declinó responder", "resumen": historial[-1]["content"]}
    texto = "".join(b.text for b in r.content if b.type == "text").strip()
    for b in r.content:
        if b.type == "tool_use" and b.name == "pasar_a_humano":
            return texto, {"motivo": str(b.input.get("motivo", ""))[:500],
                           "resumen": str(b.input.get("resumen", ""))[:2000]}
    return texto, None


async def procesar(m: dict) -> None:
    """Tarea en segundo plano por mensaje entrante. Nunca propaga excepciones."""
    try:
        await _procesar(m)
    except Exception:
        log.exception("fallo procesando el mensaje %s", m.get("id"))


async def _procesar(m: dict) -> None:
    cliente = await db.cliente_por_numero(m["phone_number_id"])
    if cliente is None:
        log.warning("mensaje para un número sin bot activo: %s", m["phone_number_id"])
        return
    cid, tel = cliente["id"], m["wa_id"]

    async with _locks[(cid, tel)]:
        conv = await db.conversacion(cid, tel, m.get("nombre"))
        texto = m["texto"] if m["tipo"] == "text" and m["texto"] else f"[{m['tipo']}]"
        if not await db.guardar_mensaje(cid, conv["id"], "in", texto, m["id"]):
            return  # entrega duplicada
        pausado = conv["pausado_hasta"]
        if pausado and pausado > datetime.now(timezone.utc):
            return  # un humano está atendiendo
        if await db.mensajes_ultima_hora(cid, conv["id"]) > config.MAX_MSGS_HORA:
            log.warning("tope por hora superado: cliente=%s tel=%s", cid, tel)
            return

        humano = None
        if texto.startswith("[") and m["tipo"] != "text":
            respuesta = SOLO_TEXTO
        elif ESCALAR.search(texto):
            respuesta = TE_PASO
            humano = {"motivo": "El cliente pidió atención humana o tocó un tema sensible", "resumen": texto}
        else:
            try:
                historial = _a_mensajes(await db.historial(cid, conv["id"], config.HISTORIAL))
                respuesta, humano = await pedir_respuesta(cliente["prompt_sistema"], historial)
                if not respuesta:
                    respuesta = TE_PASO if humano else SIN_RESPUESTA
            except Exception:
                log.exception("fallo del modelo; se escala a humano (cliente=%s)", cid)
                respuesta, humano = FALLO_IA, {"motivo": "Falla técnica del asistente", "resumen": texto}

        try:
            await whatsapp.enviar_texto(m["phone_number_id"], tel, respuesta)
            await db.guardar_mensaje(cid, conv["id"], "out", respuesta)
        except Exception:
            log.exception("no se pudo responder a %s", tel)

        if humano:
            await db.escalar(cid, conv["id"], humano["motivo"], humano["resumen"], config.PAUSA_MINUTOS)
            await events.emitir("conversacion.escalada", {
                "cliente": cliente["nombre"], "telefono": tel, "nombre": m.get("nombre"), **humano})
