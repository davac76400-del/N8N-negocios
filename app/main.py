import json
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import bot, config, db, events, whatsapp
from .models import Solicitud
from .prompt import construir_prompt

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
WEB = Path(__file__).resolve().parent.parent / "web"


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.validar()
    await db.init()
    yield
    await db.close()


# Sin /docs ni /openapi.json: no hay razón para publicar el mapa de la API.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=WEB), name="static")


@app.middleware("http")
async def cabeceras_seguras(request: Request, call_next):
    r = await call_next(request)
    r.headers["Content-Security-Policy"] = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["Referrer-Policy"] = "no-referrer"
    return r


@app.exception_handler(db.NoEncontrado)
async def _404(_, __):
    return JSONResponse({"detail": "no encontrado"}, status_code=404)


@app.exception_handler(db.Conflicto)
async def _409(_, e):
    return JSONResponse({"detail": str(e)}, status_code=409)


@app.get("/health")
async def health():
    try:
        await db.salud()
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)
    return {"ok": True}


# --- Fase 1: formulario público -------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def formulario():
    return FileResponse(WEB / "index.html")


@app.post("/api/solicitudes", status_code=201)
async def crear_solicitud(s: Solicitud):
    if s.website:  # honeypot: se responde "ok" para no dar pistas al bot
        return {"id": None}
    return {"id": await db.crear_solicitud(s.model_dump(exclude={"website"}))}


# --- Fases 2 y 3: panel del administrador ---------------------------------------------------

_basic = HTTPBasic()


def autenticar(c: HTTPBasicCredentials = Depends(_basic)) -> None:
    usuario_ok = secrets.compare_digest(c.username.encode(), config.ADMIN_USER.encode())
    clave_ok = secrets.compare_digest(c.password.encode(), config.ADMIN_PASSWORD.encode())
    if not (usuario_ok and clave_ok):
        raise HTTPException(401, "credenciales inválidas", headers={"WWW-Authenticate": "Basic"})


admin = APIRouter(prefix="/admin", dependencies=[Depends(autenticar)])


class Aprobacion(BaseModel):
    wa_phone_number_id: str | None = Field(None, pattern=r"^\d{5,25}$")


class Rechazo(BaseModel):
    motivo: str = Field(min_length=3, max_length=500)


class Numero(BaseModel):
    wa_phone_number_id: str | None = Field(None, pattern=r"^\d{5,25}$")  # null = apagar el bot


@admin.get("", include_in_schema=False)
async def panel():
    return FileResponse(WEB / "admin.html")


@admin.get("/api/solicitudes")
async def listar_solicitudes(estado: str | None = Query(None, pattern="^(pendiente|aprobada|rechazada)$")):
    return [dict(r) for r in await db.listar_solicitudes(estado)]


@admin.get("/api/solicitudes/{sid}")
async def ver_solicitud(sid: UUID):
    r = dict(await db.solicitud(sid))
    r["prompt_preview"] = construir_prompt(r["datos"])
    return r


@admin.post("/api/solicitudes/{sid}/aprobar")
async def aprobar(sid: UUID, cuerpo: Aprobacion):
    """Clic en 'Aprobar': crea el negocio y su bot, y dispara el evento hacia la capa de ejecución."""
    r = await db.aprobar(sid, cuerpo.wa_phone_number_id)
    webhook = await events.emitir("solicitud.aprobada", {
        "solicitud_id": sid, "cliente_id": r["cliente_id"], "datos": r["datos"],
        "prompt_sistema": r["prompt_sistema"]})
    return {"cliente_id": r["cliente_id"], "webhook": webhook}


@admin.post("/api/solicitudes/{sid}/rechazar")
async def rechazar(sid: UUID, cuerpo: Rechazo):
    await db.rechazar(sid, cuerpo.motivo)
    return {"ok": True}


@admin.get("/api/clientes")
async def listar_clientes():
    return [dict(r) for r in await db.listar_clientes()]


@admin.put("/api/clientes/{cid}/numero")
async def asignar_numero(cid: UUID, cuerpo: Numero):
    await db.asignar_numero(cid, cuerpo.wa_phone_number_id)
    return {"ok": True}


@admin.get("/api/escalaciones")
async def escalaciones():
    return [dict(r) for r in await db.escalaciones_pendientes()]


@admin.get("/api/conversaciones/{conv_id}/mensajes")
async def mensajes(conv_id: UUID):
    return [dict(r) for r in await db.mensajes_de(conv_id)]


@admin.post("/api/conversaciones/{conv_id}/atender")
async def atender(conv_id: UUID):
    await db.atender(conv_id)
    return {"ok": True}


app.include_router(admin)


# --- WhatsApp Cloud API ---------------------------------------------------------------------

@app.get("/webhook/whatsapp", include_in_schema=False)
async def wa_verificar(request: Request):
    q = request.query_params
    if not config.WA_VERIFY_TOKEN:
        raise HTTPException(503, "WhatsApp no está configurado")
    token_ok = secrets.compare_digest(q.get("hub.verify_token", "").encode(), config.WA_VERIFY_TOKEN.encode())
    if q.get("hub.mode") == "subscribe" and token_ok:
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(403)


@app.post("/webhook/whatsapp", include_in_schema=False)
async def wa_recibir(request: Request, tareas: BackgroundTasks):
    if not config.WA_APP_SECRET:
        raise HTTPException(503, "WhatsApp no está configurado")
    cuerpo = await request.body()
    if not whatsapp.firma_valida(cuerpo, request.headers.get("x-hub-signature-256")):
        raise HTTPException(403)
    try:
        payload = json.loads(cuerpo)
    except ValueError:
        raise HTTPException(400) from None
    # Se responde 200 de inmediato (Meta reintenta si tarda); el trabajo sigue en segundo plano.
    # ponytail: si el contenedor muere a mitad de un mensaje, ese mensaje queda sin respuesta.
    for m in whatsapp.extraer_mensajes(payload):
        tareas.add_task(bot.procesar, m)
    return {"ok": True}
