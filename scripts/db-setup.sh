#!/usr/bin/env bash
# Creates the database and the two roles used by Marqbee, then runs migrations.
#   marqbee_service: owns the schema, BYPASSRLS — webhook ingest, workers, migrations
#   marqbee_app:     subject to row-level security — dashboard API
# Run as a Postgres superuser (locally: `sudo -u postgres` or PGUSER=postgres).
set -euo pipefail
DB="${PGDATABASE_NAME:-marqbee}"
PSQL=(psql -v ON_ERROR_STOP=1 -X -q)
if [ "$(id -u)" = "0" ] && command -v sudo >/dev/null && [ -z "${PGUSER:-}" ]; then PSQL=(sudo -u postgres "${PSQL[@]}"); fi

"${PSQL[@]}" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marqbee_service') THEN
    CREATE ROLE marqbee_service LOGIN BYPASSRLS PASSWORD 'marqbee_service';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marqbee_app') THEN
    CREATE ROLE marqbee_app LOGIN PASSWORD 'marqbee_app';
  END IF;
END \$\$;
SQL
for d in "$DB" ${EXTRA_DBS:-}; do
  if ! "${PSQL[@]}" -d postgres -tAc "select 1 from pg_database where datname='$d'" | grep -q 1; then
    "${PSQL[@]}" -d postgres -c "CREATE DATABASE \"$d\" OWNER marqbee_service"
  fi
  "${PSQL[@]}" -d "$d" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
done

DATABASE_SERVICE_URL="${DATABASE_SERVICE_URL:-postgres://marqbee_service:marqbee_service@localhost:5432/$DB}" \
  pnpm --filter @marqbee/db migrate
