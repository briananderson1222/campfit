#!/bin/sh
set -eu

docker compose -f docker-compose.postgres.yml down -v
npm run db:local:up
npm run db:local:schema

if [ "${SEED_LOCAL_DB:-0}" = "1" ]; then
  DATABASE_URL="${LOCAL_DATABASE_URL:-postgresql://campfit:campfit_local@127.0.0.1:54329/campfit_local?sslmode=disable}" \
    npm run seed
else
  echo "Local database reset without seed data. Set SEED_LOCAL_DB=1 to seed."
fi

