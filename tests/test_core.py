"""Pruebas sin red ni base de datos: prompt, firma de Meta, parseo del webhook y escalación."""
import hashlib
import hmac

import pytest

from app import config, whatsapp
from app.bot import ESCALAR, _a_mensajes
from app.models import Solicitud
from app.prompt import construir_prompt

DATOS = {
    "negocio": "Tacos Don Beto", "sector": "Restaurante", "descripcion": "Tacos al pastor desde 1998.",
    "moneda": "MXN", "nombre_bot": "Beto", "tono": "Cercano y amable", "estilo": "tutea",
    "restricciones": "No ofrecer descuentos", "directrices": "", "horarios": "Lun-Sáb 9 a 20 h",
    "cobertura": "Centro de Oaxaca", "politica_entrega": "Envío gratis arriba de $200",
    "catalogo": [
        {"nombre": "Taco al pastor", "precio": 25, "categoria": "Tacos", "descripcion": "Con piña", "variantes": ""},
        {"nombre": "Agua de horchata", "precio": 12.5, "categoria": "Bebidas", "descripcion": "", "variantes": "1 L / 500 ml"},
        {"nombre": "Catering", "precio": None, "categoria": "Bebidas", "descripcion": "", "variantes": ""},
    ],
    "faqs": [{"pregunta": "¿Aceptan tarjeta?", "respuesta": "Sí, todas."}],
}


def test_prompt_incluye_todo_el_cuestionario():
    p = construir_prompt(DATOS)
    for esperado in ("Beto", "Tacos Don Beto", "Cercano y amable", "No ofrecer descuentos", "Lun-Sáb 9 a 20 h",
                     "Centro de Oaxaca", "Envío gratis", "## Tacos", "## Bebidas", "Taco al pastor — $25. Con piña",
                     "Agua de horchata — $12.50", "Variantes: 1 L / 500 ml", "Catering — precio a consultar",
                     "P: ¿Aceptan tarjeta?", "R: Sí, todas.", "pasar_a_humano", "nunca inventes precios".lower()):
        assert esperado.lower() in p.lower(), esperado


def test_prompt_omite_secciones_vacias():
    d = {**DATOS, "faqs": [], "cobertura": "", "estilo": ""}
    p = construir_prompt(d)
    assert "Preguntas frecuentes" not in p and "Zonas de cobertura" not in p and "Estilo" not in p


def test_firma_de_meta():
    cuerpo = b'{"hola":1}'
    ok = "sha256=" + hmac.new(config.WA_APP_SECRET.encode(), cuerpo, hashlib.sha256).hexdigest()
    assert whatsapp.firma_valida(cuerpo, ok)
    assert not whatsapp.firma_valida(cuerpo, ok[:-1] + "0")
    assert not whatsapp.firma_valida(b"otro", ok)
    assert not whatsapp.firma_valida(cuerpo, None)


def test_extraer_mensajes_ignora_estados():
    payload = {"entry": [{"changes": [{"value": {
        "metadata": {"phone_number_id": "111"},
        "contacts": [{"wa_id": "52951", "profile": {"name": "Ana"}}],
        "messages": [{"from": "52951", "id": "wamid.1", "type": "text", "text": {"body": "hola"}},
                     {"from": "52951", "id": "wamid.2", "type": "image"}],
        "statuses": [{"id": "wamid.9", "status": "read"}]}}]}]}
    ms = whatsapp.extraer_mensajes(payload)
    assert [(m["id"], m["tipo"], m["texto"], m["nombre"]) for m in ms] == [
        ("wamid.1", "text", "hola", "Ana"), ("wamid.2", "image", "", "Ana")]
    assert whatsapp.extraer_mensajes({"entry": [{"changes": [{"value": {"statuses": [{}]}}]}]}) == []


@pytest.mark.parametrize("texto", [
    "quiero hablar con un humano", "Quiero hablar con alguien", "tengo una queja", "Soy alérgico al cacahuate",
    "me dio intoxicación", "quiero un reembolso", "voy a ir a Profeco", "pásame al gerente", "me hicieron un cobro indebido",
    "mi abogado les escribirá",
])
def test_escalacion_deterministica_si(texto):
    assert ESCALAR.search(texto)


@pytest.mark.parametrize("texto", [
    "mesa para 4 personas", "¿cuánto cuesta el taco?", "hola buenas tardes", "quiero 3 de pastor", "¿abren el domingo?",
])
def test_escalacion_deterministica_no(texto):
    assert not ESCALAR.search(texto)


def test_historial_empieza_con_usuario():
    filas = [{"direccion": "out", "contenido": "a"}, {"direccion": "in", "contenido": "b"}, {"direccion": "out", "contenido": "c"}]
    assert _a_mensajes(filas) == [{"role": "user", "content": "b"}, {"role": "assistant", "content": "c"}]


def test_solicitud_exige_contacto_y_catalogo():
    base = {**DATOS, "contacto_nombre": "Beto", "catalogo": [{"nombre": "x"}], "aviso_privacidad": True}
    base.pop("faqs")
    with pytest.raises(ValueError, match="contacto"):
        Solicitud(**base)
    Solicitud(**base, contacto_telefono="9510000000")
    with pytest.raises(ValueError):
        Solicitud(**{**base, "catalogo": [], "contacto_telefono": "9510000000"})
    with pytest.raises(ValueError, match="aviso de privacidad"):  # sin consentimiento no hay solicitud
        Solicitud(**{**base, "aviso_privacidad": False, "contacto_telefono": "9510000000"})
    with pytest.raises(ValueError):  # campos desconocidos no pasan
        Solicitud(**base, contacto_telefono="9510000000", extra="x")
