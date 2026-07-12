#!/bin/sh
set -eu

compose_file="docker-compose.postgres.yml"
service="postgres"

apply_sql() {
  docker compose -f "$compose_file" exec -T "$service" \
    psql --set ON_ERROR_STOP=1 --username campfit --dbname campfit_local \
    --file "/workspace/$1"
}

apply_sql "prisma/migrations/001_initial_schema.sql"
apply_sql "scripts/sql/admin-schema.sql"

for migration in \
  prisma/migrations/002_provider_and_field_sources.sql \
  prisma/migrations/003_camp_reports.sql \
  prisma/migrations/004_array_types_and_address.sql \
  prisma/migrations/005_admin_trust_platform.sql \
  prisma/migrations/006_provider_change_proposals.sql \
  prisma/migrations/007_moderator_roles.sql \
  prisma/migrations/008_provider_person_change_logs.sql \
  prisma/migrations/009_survey_review_events.sql \
  prisma/migrations/010_survey_review_sessions.sql \
  prisma/migrations/011_proposal_applied_fields.sql \
  prisma/migrations/012_claim_store_and_session_identity.sql \
  prisma/migrations/013_provider_candidates.sql \
  prisma/migrations/014_crawl_run_camp_log.sql \
  prisma/migrations/015_proposal_snapshot_ref.sql \
  prisma/migrations/016_crawl_schedule.sql \
  prisma/migrations/017_aggregator_discovery.sql \
  prisma/migrations/018_review_batch_accept_audit.sql \
  prisma/migrations/019_provider_requires_render.sql
do
  apply_sql "$migration"
done

echo "Local CampFit schema applied."

