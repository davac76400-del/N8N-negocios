"""Flujo completo contra Postgres real: formulario -> panel -> aprobación -> WhatsApp -> escalación.

Corre solo con TEST_DATABASE_URL (una base desechable: se BORRA y recrea el esquema).
WhatsApp y el LLM se simulan; todo lo demás es el código real.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.skipif(not os.environ.get("TEST_DATABASE_URL"), reason="falta TEST_DATABASE_URL")

DB = Path(__file__).resolve().parent.parent / "db"
AUTH = ("admin", "clave-de-prueba-123")
SECRETO = "secreto-de-app"

SOLICITUD = {
    "contacto_nombre": "Beto", "contacto_telefono": "9510000000", "negocio": "Tacos Don Beto", "sector": "Restaurante",
    "aviso_privacidad": True, "horarios": "Lun-Sáb 9 a 20 h", "tono": "Cercano y amable",
    "catalogo": [{"nombre": "Taco al pastor", "precio": 25, "categoria": "Tacos"}],
    "faqs": [{"pregunta": "¿Aceptan tarjeta?", "respuesta": "Sí."}],
}

estado: dict = {}


async def _sql(*consultas):
    c = await asyncpg.connect(os.environ["TEST_DATABASE_URL"])
    try:
        for q in consultas:
            await c.execute(q)
    finally:
        await c.close()


@pytest.fixture(scope="module")
def web():
    # Roles y privilegios por defecto como en Supabase: el esquema debe quitárselos a anon.
    asyncio.run(_sql(
        """do $$ begin
             if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
             if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
           end $$""",
        "grant usage on schema public to anon, authenticated",
        "alter default privileges in schema public grant all on tables to anon, authenticated",
        (DB / "001_down.sql").read_text(), (DB / "001_esquema.sql").read_text(),
        (DB / "001_esquema.sql").read_text(),  # idempotente: correrlo dos veces no rompe
        (DB / "002_mensualidad.sql").read_text(),
    ))
    from app import bot, config, whatsapp
    from app.main import app

    enviados, historiales = [], []

    async def enviar(pid, destino, texto):
        enviados.append((pid, destino, texto))

    async def llm(prompt, historial):
        historiales.append((prompt, historial))
        if "pedido" in historial[-1]["content"]:
            return "Anoto tu pedido.", {"motivo": "Pedido listo", "resumen": "2 tacos al pastor"}
        if "romper" in historial[-1]["content"]:
            raise RuntimeError("API caída")
        return "Hola, soy Beto.", None

    mp = pytest.MonkeyPatch()
    mp.setattr(whatsapp, "enviar_texto", enviar)
    mp.setattr(bot, "pedir_respuesta", llm)
    estado.update(enviados=enviados, historiales=historiales, config=config, monkeypatch=mp)
    with TestClient(app) as c:
        yield c
    mp.undo()


def wa(web, texto, wa_id="5219510000001", pid="100000000000001", mid=None, tipo="text", firmar=True):
    payload = {"entry": [{"changes": [{"value": {
        "metadata": {"phone_number_id": pid}, "contacts": [{"wa_id": wa_id, "profile": {"name": "Ana"}}],
        "messages": [{"from": wa_id, "id": mid or f"wamid.{uuid4()}", "type": tipo, "text": {"body": texto}}]}}]}]}
    cuerpo = json.dumps(payload).encode()
    firma = "sha256=" + hmac.new(SECRETO.encode(), cuerpo, hashlib.sha256).hexdigest()
    return web.post("/webhook/whatsapp", content=cuerpo, headers={
        "x-hub-signature-256": firma if firmar else "sha256=mala", "content-type": "application/json"})


def respuestas():
    return estado["enviados"]


def test_health_y_formulario(web):
    assert web.get("/health").json() == {"ok": True}
    r = web.get("/")
    assert r.status_code == 200 and "Crea el bot" in r.text
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert web.get("/docs").status_code == 404


def test_formulario_valida_y_guarda(web):
    assert web.post("/api/solicitudes", json={**SOLICITUD, "catalogo": []}).status_code == 422
    assert web.post("/api/solicitudes", json={**SOLICITUD, "aviso_privacidad": False}).status_code == 422  # sin aviso, no se guarda
    assert web.get("/aviso-de-privacidad").status_code == 200
    sin_contacto = {k: v for k, v in SOLICITUD.items() if k != "contacto_telefono"}
    assert web.post("/api/solicitudes", json=sin_contacto).status_code == 422
    # honeypot: parece éxito pero no guarda
    assert web.post("/api/solicitudes", json={**SOLICITUD, "website": "http://spam"}).json() == {"id": None}
    r = web.post("/api/solicitudes", json=SOLICITUD)
    assert r.status_code == 201
    estado["sol1"] = r.json()["id"]


def test_panel_exige_login(web):
    for ruta in ("/admin", "/admin/api/solicitudes", "/admin/api/clientes"):
        assert web.get(ruta).status_code == 401
    assert web.get("/admin/api/solicitudes", auth=("admin", "mala")).status_code == 401
    assert web.post(f"/admin/api/solicitudes/{estado['sol1']}/aprobar", json={}).status_code == 401
    r = web.get("/admin/api/solicitudes?estado=pendiente", auth=AUTH)
    assert [s["id"] for s in r.json()] == [estado["sol1"]]  # el honeypot no se guardó
    assert "Centro de control" in web.get("/admin", auth=AUTH).text


def test_detalle_trae_prompt_generado(web):
    r = web.get(f"/admin/api/solicitudes/{estado['sol1']}", auth=AUTH).json()
    assert "Taco al pastor — $25" in r["prompt_preview"] and r["datos"]["negocio"] == "Tacos Don Beto"


def test_aprobar_crea_bot_una_sola_vez(web):
    url = f"/admin/api/solicitudes/{estado['sol1']}/aprobar"
    assert web.post(url, json={"wa_phone_number_id": "abc"}, auth=AUTH).status_code == 422
    r = web.post(url, json={"wa_phone_number_id": "100000000000001"}, auth=AUTH)
    assert r.status_code == 200 and r.json()["webhook"] == "no configurado"
    assert web.post(url, json={"wa_phone_number_id": "100000000000001"}, auth=AUTH).status_code == 409  # doble clic
    clientes = web.get("/admin/api/clientes", auth=AUTH).json()
    assert [(c["nombre"], c["wa_phone_number_id"]) for c in clientes] == [("Tacos Don Beto", "100000000000001")]
    estado["cliente1"] = clientes[0]["id"]


def test_rechazar_y_numero_duplicado(web):
    sid = web.post("/api/solicitudes", json={**SOLICITUD, "negocio": "Otro"}).json()["id"]
    assert web.post(f"/admin/api/solicitudes/{sid}/rechazar", json={"motivo": "x"}, auth=AUTH).status_code == 422
    assert web.post(f"/admin/api/solicitudes/{sid}/rechazar", json={"motivo": "Datos incompletos"}, auth=AUTH).status_code == 200
    assert web.post(f"/admin/api/solicitudes/{sid}/aprobar", json={}, auth=AUTH).status_code == 409  # ya rechazada
    sid2 = web.post("/api/solicitudes", json={**SOLICITUD, "negocio": "Segundo"}).json()["id"]
    assert web.post(f"/admin/api/solicitudes/{sid2}/aprobar", json={"wa_phone_number_id": "100000000000001"}, auth=AUTH).status_code == 409
    assert web.post(f"/admin/api/solicitudes/{sid2}/aprobar", json={}, auth=AUTH).status_code == 200  # sin número aún
    c2 = [c for c in web.get("/admin/api/clientes", auth=AUTH).json() if c["nombre"] == "Segundo"][0]
    assert c2["wa_phone_number_id"] is None
    assert web.put(f"/admin/api/clientes/{c2['id']}/numero", json={"wa_phone_number_id": "100000000000001"}, auth=AUTH).status_code == 409
    assert web.put(f"/admin/api/clientes/{c2['id']}/numero", json={"wa_phone_number_id": "100000000000002"}, auth=AUTH).status_code == 200


def test_verificacion_y_firma_del_webhook(web):
    ok = web.get("/webhook/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "token-verificacion", "hub.challenge": "1234"})
    assert ok.status_code == 200 and ok.text == "1234"
    assert web.get("/webhook/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "mal", "hub.challenge": "1"}).status_code == 403
    assert wa(web, "hola", firmar=False).status_code == 403
    assert respuestas() == []


def test_bot_responde_una_vez_aunque_meta_reintente(web):
    assert wa(web, "hola, ¿qué tienen?", mid="wamid.fijo").status_code == 200
    assert wa(web, "hola, ¿qué tienen?", mid="wamid.fijo").status_code == 200  # reintento de Meta
    assert respuestas() == [("100000000000001", "5219510000001", "Hola, soy Beto.")]
    prompt, historial = estado["historiales"][-1]
    assert "Taco al pastor" in prompt and historial == [{"role": "user", "content": "hola, ¿qué tienen?"}]


def test_conversaciones_aisladas_por_negocio(web):
    # Mismo cliente final escribe al negocio 2: no hereda el historial del negocio 1.
    assert wa(web, "buenas", pid="100000000000002").status_code == 200
    _, historial = estado["historiales"][-1]
    assert historial == [{"role": "user", "content": "buenas"}]
    assert respuestas()[-1][0] == "100000000000002"


def test_historial_se_acumula_en_la_misma_conversacion(web):
    wa(web, "¿y los precios?")
    _, historial = estado["historiales"][-1]
    assert historial == [{"role": "user", "content": "hola, ¿qué tienen?"},
                         {"role": "assistant", "content": "Hola, soy Beto."},
                         {"role": "user", "content": "¿y los precios?"}]


def test_escalacion_por_palabra_clave_pausa_y_se_reanuda(web):
    n = len(respuestas())
    wa(web, "quiero hablar con un humano", wa_id="5219510000002")
    assert "persona del equipo" in respuestas()[-1][2] and len(respuestas()) == n + 1
    wa(web, "¿hola? ¿sigues ahí?", wa_id="5219510000002")  # el bot calla: atiende un humano
    assert len(respuestas()) == n + 1
    pendientes = web.get("/admin/api/escalaciones", auth=AUTH).json()
    esc = [e for e in pendientes if e["telefono"] == "5219510000002"]
    assert esc and esc[0]["cliente"] == "Tacos Don Beto" and "humano" in esc[0]["escalada_resumen"]
    msgs = web.get(f"/admin/api/conversaciones/{esc[0]['id']}/mensajes", auth=AUTH).json()
    assert [m["direccion"] for m in msgs] == ["in", "out", "in"]
    assert web.post(f"/admin/api/conversaciones/{esc[0]['id']}/atender", auth=AUTH).status_code == 200
    wa(web, "gracias, ya me atendieron", wa_id="5219510000002")
    assert len(respuestas()) == n + 2  # el bot vuelve a responder
    assert not [e for e in web.get("/admin/api/escalaciones", auth=AUTH).json() if e["telefono"] == "5219510000002"]


def test_escalacion_pedida_por_el_modelo(web):
    wa(web, "quiero hacer un pedido", wa_id="5219510000003")
    assert respuestas()[-1][2] == "Anoto tu pedido."
    esc = [e for e in web.get("/admin/api/escalaciones", auth=AUTH).json() if e["telefono"] == "5219510000003"]
    assert esc[0]["escalada_resumen"] == "2 tacos al pastor"


def test_si_falla_el_modelo_no_se_queda_callado(web):
    wa(web, "voy a romper todo", wa_id="5219510000004")
    assert "problema técnico" in respuestas()[-1][2]
    assert [e for e in web.get("/admin/api/escalaciones", auth=AUTH).json() if e["telefono"] == "5219510000004"]


def test_mensaje_que_no_es_texto(web):
    wa(web, "", wa_id="5219510000005", tipo="image")
    assert "solo puedo leer mensajes de texto" in respuestas()[-1][2]


def test_tope_de_mensajes_por_hora_protege_el_gasto(web):
    estado["monkeypatch"].setattr(estado["config"], "MAX_MSGS_HORA", 2)
    n = len(respuestas())
    for i in range(4):
        wa(web, f"spam {i}", wa_id="5219510000006")
    assert len(respuestas()) == n + 2


def test_cliente_pausado_no_responde_y_se_reactiva(web):
    cid = estado["cliente1"]
    assert web.put(f"/admin/api/clientes/{cid}/activo", json={"activo": False}, auth=AUTH).status_code == 200
    n = len(respuestas())
    wa(web, "hola, ¿sigues ahí?", wa_id="5219510000007")
    assert len(respuestas()) == n  # mensualidad vencida: el bot calla
    assert web.put(f"/admin/api/clientes/{cid}/activo", json={"activo": True}, auth=AUTH).status_code == 200
    wa(web, "ya pagué", wa_id="5219510000007")
    assert len(respuestas()) == n + 1


def test_anon_de_supabase_no_lee_nada():
    async def intento():
        c = await asyncpg.connect(os.environ["TEST_DATABASE_URL"])
        try:
            await c.execute("set role anon")
            for tabla in ("solicitudes", "clientes", "conversaciones", "mensajes"):
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await c.fetch(f"select * from {tabla}")
        finally:
            await c.close()
    asyncio.run(intento())


def test_todas_las_tablas_tienen_rls():
    async def sin_rls():
        c = await asyncpg.connect(os.environ["TEST_DATABASE_URL"])
        try:
            return await c.fetch(
                """select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity""")
        finally:
            await c.close()
    assert asyncio.run(sin_rls()) == []
