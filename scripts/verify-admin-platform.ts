import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { resolvePgConfig } from '@/lib/db-config';
import { loadLocalEnv } from './load-env';

loadLocalEnv();

function getDbClient() {
  const config = resolvePgConfig();
  if (!config) {
    throw new Error('Missing database env vars for admin verification');
  }

  return new Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: { rejectUnauthorized: false },
  });
}

async function verifyDatabase() {
  const client = getDbClient();
  await client.connect();
  await client.query('BEGIN');

  const tables = await client.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN (
        'ReviewFlag',
        'FieldAttestation',
        'AccreditationBody',
        'CampAccreditation',
        'Person',
        'PersonContactMethod',
        'CampPersonRole',
        'ProviderPersonRole',
        'AiActionLog',
        'CommunityModeratorAssignment',
        'ProviderChangeProposal'
      )
    ORDER BY tablename
  `);
  if (tables.rows.length < 11) {
    throw new Error(`Expected trust/admin tables to exist, found ${tables.rows.length}`);
  }

  const camp = await client.query(`SELECT id, "communitySlug" FROM "Camp" WHERE "archivedAt" IS NULL LIMIT 1`);
  const provider = await client.query(`SELECT id FROM "Provider" WHERE "archivedAt" IS NULL LIMIT 1`);
  const user = await client.query(`SELECT id FROM "User" LIMIT 1`);
  const campId = camp.rows[0]?.id;
  const providerId = provider.rows[0]?.id;
  const userId = user.rows[0]?.id;
  if (!campId || !providerId || !userId) {
    throw new Error('Need at least one user, camp, and provider to run DB verification');
  }

  const flag = await client.query(
    `INSERT INTO "ReviewFlag" ("entityType", "entityId", comment, "createdBy")
     VALUES ('CAMP', $1, 'verify flag', 'verify-script')
     RETURNING id`,
    [campId],
  );
  const attestation = await client.query(
    `INSERT INTO "FieldAttestation" ("entityType", "entityId", "fieldKey", "approvedAt", "approvedBy")
     VALUES ('CAMP', $1, 'description', now(), 'verify-script')
     RETURNING id`,
    [campId],
  );
  const moderator = await client.query(
    `INSERT INTO "CommunityModeratorAssignment" ("userId", "communitySlug", role, "createdBy")
     VALUES ($1, $2, 'MODERATOR', 'verify-script')
     ON CONFLICT ("userId", "communitySlug") DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [userId, camp.rows[0].communitySlug],
  );
  const providerProposal = await client.query(
    `INSERT INTO "ProviderChangeProposal" ("providerId", "sourceUrl", "proposedChanges", "overallConfidence")
     VALUES ($1, 'verify-script', '{}'::jsonb, 0.5)
     RETURNING id`,
    [providerId],
  );

  console.log(JSON.stringify({
    reviewFlagId: flag.rows[0].id,
    attestationId: attestation.rows[0].id,
    moderatorAssignmentId: moderator.rows[0].id,
    providerProposalId: providerProposal.rows[0].id,
  }, null, 2));

  await client.query('ROLLBACK');
  await client.end();
}

async function main() {
  execSync('npx tsx scripts/test-access.ts', { stdio: 'inherit' });
  execSync('npx tsc --noEmit', { stdio: 'inherit' });
  await verifyDatabase();
  console.log('admin platform verification complete');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
