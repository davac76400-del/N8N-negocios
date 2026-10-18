import os


def _e(nombre: str, defecto: str = "") -> str:
    return os.environ.get(nombre, defecto).strip()


DATABASE_URL = _e("DATABASE_URL")
ADMIN_USER = _e("ADMIN_USER", "admin")
ADMIN_PASSWORD = _e("ADMIN_PASSWORD")

WA_VERIFY_TOKEN = _e("WA_VERIFY_TOKEN")
WA_APP_SECRET = _e("WA_APP_SECRET")
WA_ACCESS_TOKEN = _e("WA_ACCESS_TOKEN")
GRAPH_VERSION = _e("GRAPH_VERSION", "v23.0")

CLAUDE_MODEL = _e("CLAUDE_MODEL", "claude-opus-5-5")

EVENTS_WEBHOOK_URL = _e("EVENTS_WEBHOOK_URL")
EVENTS_WEBHOOK_SECRET = _e("EVENTS_WEBHOOK_SECRET")

ZONA_HORARIA = _e("ZONA_HORARIA", "America/Mexico_City")
PAUSA_MINUTOS = int(_e("PAUSA_MINUTOS", "30"))
MAX_MSGS_HORA = int(_e("MAX_MSGS_HORA", "30"))
HISTORIAL = int(_e("HISTORIAL", "20"))

OBLIGATORIAS = (
    "DATABASE_URL", "ADMIN_PASSWORD", "WA_VERIFY_TOKEN",
    "WA_APP_SECRET", "WA_ACCESS_TOKEN", "ANTHROPIC_API_KEY",
)


def validar() -> None:
    """Falla al arrancar, no a media operación."""
    faltan = [n for n in OBLIGATORIAS if not _e(n)]
    if faltan:
        raise RuntimeError("Faltan variables de entorno: " + ", ".join(faltan))
    if len(ADMIN_PASSWORD) < 12:
        raise RuntimeError("ADMIN_PASSWORD debe tener al menos 12 caracteres")
