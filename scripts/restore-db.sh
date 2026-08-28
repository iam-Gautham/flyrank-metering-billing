#!/bin/sh
# Automated PostgreSQL Database Restore Script for FlyRank Metering & Billing Engine
# Usage: ./scripts/restore-db.sh <backup_file_path>

set -e

if [ -z "$1" ]; then
  echo "Error: Backup file path is required."
  echo "Usage: ./scripts/restore-db.sh <backup_file_path>"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Error: Backup file '${BACKUP_FILE}' not found."
  exit 1
fi

echo "Restoring database from ${BACKUP_FILE}..."

if command -v docker >/dev/null 2>&1 && docker ps | grep -q metering_billing_postgres; then
  gunzip -c "${BACKUP_FILE}" | docker exec -i metering_billing_postgres psql -U postgres -d metering_billing
else
  gunzip -c "${BACKUP_FILE}" | psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -d "${DB_NAME:-metering_billing}"
fi

echo "Database restore completed successfully."
