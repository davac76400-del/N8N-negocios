#!/usr/bin/env bash
# Respaldo de la base. Uso: DATABASE_URL=... ./scripts/backup.sh [carpeta]
# Usa la URL "Session pooler" o directa de Supabase (el pooler de transacciones no sirve para pg_dump).
# Después copia la carpeta FUERA del servidor (rclone, S3, Drive): un respaldo local no es respaldo.
set -euo pipefail
destino="${1:-./respaldos}"
mkdir -p "$destino"
archivo="$destino/bots-$(date +%F).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$archivo"
find "$destino" -name 'bots-*.sql.gz' -mtime +14 -delete
echo "OK: $archivo"
