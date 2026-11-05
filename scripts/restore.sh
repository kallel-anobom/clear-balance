#!/usr/bin/env bash
# Restaura um backup: npm run db:restore -- backups/arquivo.sql
# ATENÇÃO: substitui os dados atuais do banco pelos do arquivo.
set -euo pipefail
cd "$(dirname "$0")/.."
file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Uso: npm run db:restore -- backups/arquivo.sql" >&2
  exit 1
fi
read -r -p "Isto vai SUBSTITUIR os dados atuais por '$file'. Digite 'sim' para continuar: " answer
[ "$answer" = "sim" ] || { echo "Cancelado."; exit 1; }
docker compose exec -T db psql -U clearbalance -d clearbalance -v ON_ERROR_STOP=1 < "$file" > /dev/null
echo "Backup restaurado."
