import os

# Debe ir antes de importar `app`: config lee el entorno al importarse.
os.environ.update({
    "DATABASE_URL": os.environ.get("TEST_DATABASE_URL", ""),
    "ADMIN_USER": "admin",
    "ADMIN_PASSWORD": "clave-de-prueba-123",
    "WA_VERIFY_TOKEN": "token-verificacion",
    "WA_APP_SECRET": "secreto-de-app",
    "WA_ACCESS_TOKEN": "token-wa",
    "LLM_API_KEY": "gsk-prueba",
    "LLM_BASE_URL": "http://llm.test/v1",
    "EVENTS_WEBHOOK_URL": "",
})
