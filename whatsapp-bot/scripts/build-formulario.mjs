// Inyecta clientes/formulario.json en formulario/plantilla.html y escribe:
//   formulario/index.html          página completa, para subir a cualquier hosting
//   <salida> (opcional)            versión de solo contenido, para publicarla como Artifact
import fs from 'node:fs';
const raiz = new URL('../', import.meta.url);
const esquema = JSON.stringify(JSON.parse(fs.readFileSync(new URL('clientes/formulario.json', raiz), 'utf8')));
const parte = fs.readFileSync(new URL('formulario/plantilla.html', raiz), 'utf8').replace('/*SCHEMA*/null', esquema);
const completa = `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="robots" content="noindex">\n${parte.replace('<main', '</head>\n<body>\n<main')}\n</body>\n</html>\n`;
fs.writeFileSync(new URL('formulario/index.html', raiz), completa);
if (process.argv[2]) fs.writeFileSync(process.argv[2], parte);
console.log('formulario/index.html listo' + (process.argv[2] ? ` y ${process.argv[2]}` : ''));
