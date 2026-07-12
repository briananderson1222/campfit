#!/bin/sh
set -eu

DATABASE_URL="${LOCAL_DATABASE_URL:-postgresql://campfit:campfit_local@127.0.0.1:54329/campfit_local?sslmode=disable}" \
  npm run db:migrate

echo "Local CampFit schema applied."
