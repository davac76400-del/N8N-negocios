"""Capa de WhatsApp: API oficial de Meta (Cloud API). Sin sesiones ni QR: solo token + webhook firmado."""
import asyncio
import hashlib
import hmac
import logging

import httpx

from . import config

log = logging.getLogger("whatsapp")


def firma_valida(cuerpo: bytes, cabecera: str | None) -> bool:
    """Meta firma el cuerpo crudo con el App Secret (X-Hub-Signature-256)."""
    if not cabecera or not config.WA_APP_SECRET:
        return False
    esperado = "sha256=" + hmac.new(config.WA_APP_SECRET.encode(), cuerpo, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado.encode(), cabecera.encode())


def extraer_mensajes(payload: dict) -> list[dict]:
    """Aplana el payload del webhook. Ignora estados de entrega (statuses)."""
    salida = []
    for entrada in payload.get("entry", []):
        for cambio in entrada.get("changes", []):
            v = cambio.get("value", {})
            numero = v.get("metadata", {}).get("phone_number_id")
            nombres = {c.get("wa_id"): c.get("profile", {}).get("name") for c in v.get("contacts", [])}
            for m in v.get("messages", []):
                salida.append({
                    "phone_number_id": numero,
                    "wa_id": m.get("from"),
                    "id": m.get("id"),
                    "tipo": m.get("type", "unknown"),
                    "texto": (m.get("text") or {}).get("body", ""),
                    "nombre": nombres.get(m.get("from")),
                })
    return [m for m in salida if m["phone_number_id"] and m["wa_id"] and m["id"]]


async def enviar_texto(phone_number_id: str, destino: str, texto: str) -> None:
    url = f"https://graph.facebook.com/{config.GRAPH_VERSION}/{phone_number_id}/messages"
    cuerpo = {"messaging_product": "whatsapp", "to": destino, "type": "text",
              "text": {"body": texto[:4000], "preview_url": False}}
    cabeceras = {"Authorization": f"Bearer {config.WA_ACCESS_TOKEN}"}
    async with httpx.AsyncClient(timeout=15) as http:
        for intento in range(3):
            try:
                r = await http.post(url, json=cuerpo, headers=cabeceras)
            except httpx.TransportError as e:
                log.warning("envío WhatsApp, error de red (intento %s): %s", intento + 1, e)
            else:
                if r.status_code < 400:
                    return
                if r.status_code < 500 and r.status_code != 429:
                    # 4xx (token vencido, número inválido, fuera de ventana de 24 h): reintentar no sirve.
                    raise RuntimeError(f"WhatsApp rechazó el mensaje ({r.status_code}): {r.text[:300]}")
                log.warning("envío WhatsApp, %s (intento %s)", r.status_code, intento + 1)
            await asyncio.sleep(2 ** intento)
    raise RuntimeError("WhatsApp no respondió tras 3 intentos")
