#!/usr/bin/env bash
# Backup local do banco: gera um arquivo .sql em backups/ (contém seus dados financeiros — guarde com cuidado).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/clear-balance-$(date +%Y%m%d-%H%M%S).sql"
umask 077
docker compose exec -T db pg_dump -U clearbalance --clean --if-exists clearbalance > "$file"
echo "Backup salvo em $file"
