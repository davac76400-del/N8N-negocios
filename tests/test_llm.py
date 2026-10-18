"""Cliente del LLM (chat/completions) contra un servidor simulado: sin red ni claves reales."""
import asyncio
import json

import httpx
import pytest

from app import bot

HISTORIAL = [{"role": "user", "content": "quiero 2 tacos"}]
_real = httpx.AsyncClient


def respuesta(contenido="Hola", tool=None):
    msg = {"role": "assistant", "content": contenido}
    if tool is not None:
        msg["tool_calls"] = [{"id": "c1", "type": "function", "function": {"name": "pasar_a_humano", "arguments": tool}}]
    return httpx.Response(200, json={"choices": [{"message": msg}]})


@pytest.fixture
def servidor(monkeypatch):
    """Instala un manejador; devuelve la lista de peticiones recibidas."""
    class Peticiones(list):
        def programar(self, *hs):
            manejadores.extend(hs)

    peticiones, manejadores = Peticiones(), []

    def handler(req: httpx.Request):
        peticiones.append(req)
        return manejadores.pop(0)(req) if len(manejadores) > 1 else manejadores[0](req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: _real(transport=httpx.MockTransport(handler), **kw))

    async def sin_espera(_):
        pass
    monkeypatch.setattr(bot.asyncio, "sleep", sin_espera)
    return peticiones


def pedir():
    return asyncio.run(bot.pedir_respuesta("PROMPT DEL NEGOCIO", HISTORIAL))


def test_texto_simple_y_forma_de_la_peticion(servidor):
    servidor.programar(lambda r: respuesta("Son $25 cada uno."))
    assert pedir() == ("Son $25 cada uno.", None)
    r = servidor[0]
    assert str(r.url) == "http://llm.test/v1/chat/completions" and r.headers["authorization"] == "Bearer gsk-prueba"
    cuerpo = json.loads(r.content)
    assert cuerpo["messages"][0]["role"] == "system" and "PROMPT DEL NEGOCIO" in cuerpo["messages"][0]["content"]
    assert "Fecha y hora actual" in cuerpo["messages"][0]["content"]
    assert cuerpo["messages"][1:] == HISTORIAL
    assert cuerpo["tools"][0]["function"]["name"] == "pasar_a_humano"


def test_llamada_a_pasar_a_humano(servidor):
    args = json.dumps({"motivo": "Pedido listo", "resumen": "2 tacos al pastor"})
    servidor.programar(lambda r: respuesta("Anoto tu pedido.", tool=args))
    assert pedir() == ("Anoto tu pedido.", {"motivo": "Pedido listo", "resumen": "2 tacos al pastor"})


def test_argumentos_mal_formados_igual_escalan(servidor):
    servidor.programar(lambda r: respuesta("", tool="{no es json"))
    texto, humano = pedir()
    assert texto == "" and humano["motivo"] == "Solicitud del cliente" and humano["resumen"] == "quiero 2 tacos"


def test_429_espera_y_reintenta_una_vez(servidor):
    servidor.programar(lambda r: httpx.Response(429, headers={"retry-after": "2"}), lambda r: respuesta("ok"))
    assert pedir() == ("ok", None)
    assert len(servidor) == 2


def test_400_con_herramientas_reintenta_sin_ellas(servidor):
    servidor.programar(lambda r: httpx.Response(400, json={"error": "tool_use_failed"}), lambda r: respuesta("sin tools"))
    assert pedir() == ("sin tools", None)
    assert "tools" in json.loads(servidor[0].content) and "tools" not in json.loads(servidor[1].content)


def test_error_persistente_se_propaga(servidor):
    servidor.programar(lambda r: httpx.Response(500))
    with pytest.raises(httpx.HTTPStatusError):
        pedir()
    assert len(servidor) == 1  # los 5xx no se reintentan: el bot escala a humano
