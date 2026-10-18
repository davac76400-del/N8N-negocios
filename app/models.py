from pydantic import BaseModel, ConfigDict, Field, model_validator


class _Base(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class Producto(_Base):
    nombre: str = Field(min_length=1, max_length=120)
    precio: float | None = Field(None, ge=0, le=10_000_000)  # None = "a consultar"
    descripcion: str = Field("", max_length=500)
    variantes: str = Field("", max_length=300)
    categoria: str = Field("", max_length=80)


class Faq(_Base):
    pregunta: str = Field(min_length=1, max_length=300)
    respuesta: str = Field(min_length=1, max_length=1000)


class Solicitud(_Base):
    """Cuestionario del formulario público (fase 1). Los límites protegen la BD y el prompt."""

    # Contacto
    contacto_nombre: str = Field(min_length=2, max_length=120)
    contacto_email: str | None = Field(None, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    contacto_telefono: str | None = Field(None, max_length=30)
    # Negocio
    negocio: str = Field(min_length=2, max_length=120)
    sector: str = Field(min_length=2, max_length=120)
    descripcion: str = Field("", max_length=1000)
    moneda: str = Field("MXN", max_length=8)
    catalogo: list[Producto] = Field(min_length=1, max_length=300)
    # Reglas de negocio
    horarios: str = Field(min_length=2, max_length=1000)
    cobertura: str = Field("", max_length=1000)
    politica_entrega: str = Field("", max_length=1000)
    faqs: list[Faq] = Field(default_factory=list, max_length=50)
    # Personalidad del bot
    nombre_bot: str = Field("Asistente", min_length=1, max_length=60)
    tono: str = Field(min_length=2, max_length=100)
    estilo: str = Field("", max_length=300)
    restricciones: str = Field("", max_length=1000)
    directrices: str = Field("", max_length=1000)
    # Honeypot anti-bots: un humano nunca lo llena.
    website: str = Field("", max_length=200)
    # Consentimiento: no se envía la solicitud sin aceptar el aviso de privacidad.
    aviso_privacidad: bool = False

    @model_validator(mode="after")
    def _algun_contacto(self):
        if not (self.contacto_email or self.contacto_telefono):
            raise ValueError("indica un correo o un teléfono de contacto")
        if not self.aviso_privacidad:
            raise ValueError("debes aceptar el aviso de privacidad")
        return self
