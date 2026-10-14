# Pruebas con el número real (antes de entregar a un cliente)

Márcalas con el número del bot ya conectado. Revisa también el historial en Supabase (`mensajes`).

- [ ] Reserva normal completa (llegada, salida, personas, nombre, "SÍ") → llega folio y el dueño recibe el aviso
- [ ] Reserva en un solo mensaje ("del 12 al 15 de noviembre para 2 personas a nombre de Ana")
- [ ] Fecha ambigua ("el viernes") → pide fecha exacta
- [ ] Cliente cambia de opinión a mitad ("mejor cancelar" / "NO" en el resumen)
- [ ] Pregunta fuera de alcance → no inventa; tras 3 seguidas, escala
- [ ] Queja fuerte con groserías → avisa al dueño y el bot calla
- [ ] "Quiero hablar con una persona" → igual
- [ ] Mientras el bot está callado, un mensaje nuevo NO recibe respuesta; pasados los minutos de pausa, sí
- [ ] Dos conversaciones simultáneas de números distintos no se mezclan
- [ ] En inglés: reserva completa con fecha tipo "Nov 20" y "11/20" (cliente de EE. UU.: mes/día)
- [ ] Cliente que escribe en español a un negocio en inglés (y al revés) → contesta en su idioma
- [ ] El dueño recibe el aviso con la plantilla en el idioma del negocio
- [ ] Mandar una foto o audio → pide texto, no se rompe
- [ ] Mensaje repetido (Meta reenvía webhooks) → una sola respuesta
- [ ] Apagar Supabase un momento durante una reserva → el bot NO dice "recibida" y avisa a una persona
