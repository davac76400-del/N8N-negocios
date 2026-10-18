"""Eventos salientes (fase 3): aprobación de solicitudes y escalaciones a humano.

POST firmado (HMAC-SHA256 en X-Signature) a EVENTS_WEBHOOK_URL: n8n, Telegram, Slack, lo que sea.
Es opcional: sin URL, todo sigue funcionando y las escalaciones se ven en el panel.
"""
import hashlib
import hmac
import json
import logging

import httpx

from . import config

log = logging.getLogger("events")


async def emitir(evento: str, datos: dict) -> str:
    """Devuelve 'enviado', 'fallo' o 'no configurado'. Nunca lanza."""
    if not config.EVENTS_WEBHOOK_URL:
        return "no configurado"
    cuerpo = json.dumps({"evento": evento, **datos}, default=str, ensure_ascii=False).encode()
    firma = hmac.new(config.EVENTS_WEBHOOK_SECRET.encode(), cuerpo, hashlib.sha256).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(config.EVENTS_WEBHOOK_URL, content=cuerpo, headers={
                "Content-Type": "application/json", "X-Signature": f"sha256={firma}"})
            r.raise_for_status()
        return "enviado"
    except Exception:
        log.exception("no se pudo enviar el evento %s", evento)
        return "fallo"
