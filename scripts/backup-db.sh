#!/bin/sh
# Automated PostgreSQL Database Backup Script for FlyRank Metering & Billing Engine
# Usage: ./scripts/backup-db.sh [backup_file_path]

set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y%m%m_%H%M%S)
BACKUP_FILE="${1:-${BACKUP_DIR}/metering_billing_backup_${TIMESTAMP}.sql.gz}"

mkdir -p "${BACKUP_DIR}"

echo "Starting database backup to ${BACKUP_FILE}..."

if command -v docker >/dev/null 2>&1 && docker ps | grep -q metering_billing_postgres; then
  docker exec -i metering_billing_postgres pg_dump -U postgres metering_billing | gzip > "${BACKUP_FILE}"
else
  pg_dump -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" "${DB_NAME:-metering_billing}" | gzip > "${BACKUP_FILE}"
fi

echo "Database backup completed successfully: ${BACKUP_FILE}"
