/**
 * lib/admin/claim-store.ts — Postgres materialization of `@kontourai/surface`'s
 * ClaimStore/TrustBundle shapes.
 *
 * Consumes `@kontourai/surface`'s async `ClaimStoreAdapter` seam
 * (`{name, load(): Promise<ClaimStore>, save(store): Promise<void>}`,
 * `store.d.ts`) directly — this module does not redefine that interface, it
 * implements it (`createPostgresClaimStoreAdapter`), adapting
 * `examples/postgres-claim-store/src/postgres-claim-store-adapter.ts` (the
 * upstream reference implementation shipped in the package's `files[]`) to
 * campfit's own normalized schema (migration 012:
 * `prisma/migrations/012_claim_store_and_session_identity.sql`) rather than
 * the reference's own `schema.sql`. See the "ClaimStore Postgres
 * materialization" narrative in
 * `.kontourai/flow-agents/verification-authority/verification-authority--deliver-plan.md`
 * for the full rationale (why normalized tables instead of one JSONB blob,
 * why writes round-trip through Surface's own pure functions instead of a
 * hand-rolled diff).
 *
 * Every mutation goes through Surface's own `buildClaimDefinition`/
 * `addClaimToStore`/`updateClaimInStore`/`addAuthoredClaim`/
 * `updateAuthoredClaim` on an in-memory `ClaimStore` reconstructed by
 * `createPostgresClaimStoreAdapter(...).load()`, then persists the result via
 * `.save()` — never a hand-rolled row-level diff of claim-catalog semantics.
 * `validateClaimStore`/`validateTrustBundle` run on every read and write as
 * defense-in-depth (Persistence Integrity: fail loud, never fail-open on a
 * malformed record).
 *
 * ── Schema gaps recorded here on purpose (not silently papered over) ──────
 *
 * 1. `producer` round-trip (matches the upstream reference's own documented
 *    behavior, adapted to campfit's schema): `ClaimStore.producer` is a
 *    whole-store field, but migration 012's "SurfaceClaimDefinition" table
 *    has no dedicated `producer` column. It is denormalized onto every claim
 *    row's `metadata` JSONB under the reserved key `PRODUCER_METADATA_KEY`
 *    (stripped back out of the `metadata` a caller sees when a row is read
 *    back into a `ClaimDefinition`). `load()` reads the first row's stashed
 *    producer for this subject; only when there are no rows yet does it fall
 *    back to the adapter's configured/default producer — exactly the file
 *    adapter's "empty store" behavior, exactly the reference's own documented
 *    limitation.
 * 2. `VerificationPolicy.requiredMethods` / `.requiresCorroboration` /
 *    `.collectWhen` / `.incompatibleValues` / `.incompatibleStatuses` are all
 *    valid optional fields on Surface's `VerificationPolicy` type, but
 *    migration 012's "SurfaceVerificationPolicy" table has NO columns for
 *    them (and no generic metadata/catch-all column to stash them in either).
 *    `upsertPolicy`/the adapter's `save()` FAIL LOUD if a policy sets any of
 *    them, rather than silently dropping the data — see `assertPolicySupported`.
 *    Extending migration 012 with the missing columns is out of this task's
 *    scope (files: `lib/admin/claim-store.ts` only).
 * 3. `Evidence.supportStrength` / `.integrityAnchor` / `.passing` /
 *    `.blocking` / `.execution` have no column on "SurfaceEvidence" either;
 *    `appendEvidence` fails loud if any is set, same reasoning as (2). None
 *    of `@kontourai/surface`'s own builders used by this repo today
 *    (`buildHumanAttestationEvidence`) ever set these fields.
 * 4. `ClaimGroup.description` / `.claimIds` have no dedicated column on
 *    "SurfaceClaimGroup", but that table DOES have a generic `metadata`
 *    JSONB column, so (unlike (2)/(3)) these are preserved losslessly via a
 *    reserved `metadata` sub-key (`CLAIM_GROUP_EXTRA_METADATA_KEY`) instead
 *    of failing loud — there is a safe place to put them.
 * 5. `Claim.value` (the full `Claim` interface, distinct from the identity-only
 *    `ClaimDefinition`) has no persisted channel at all in this migration:
 *    Surface's canonical `Evidence`/`VerificationEvent` types carry no generic
 *    "asserted value" field, so there is nothing to read `value` back from.
 *    `loadClaimBundle` reconstructs each full `Claim` with `value: undefined`.
 *    This is safe for this slice's purposes: `foldClaim`/`deriveClaimStatus`/
 *    `deriveTrustSnapshot` (`claim-fold.d.ts`'s `ClaimFoldInput`) derive status
 *    from claim identity/timestamps/events/evidence/policy — never from
 *    `.value` — so a `TrustBundle` built from this module still satisfies
 *    AC2's "deriveTrustSnapshot accepts unmodified" bar. A future consumer
 *    that needs to *display* what was actually asserted (e.g. a trust
 *    dashboard) should read it from the live application record (the Camp/
 *    Session's own column), exactly as `coverageFromRollup(rollup, campValues)`
 *    is already planned to do — not duplicate it into the ClaimStore.
 * 6. `recordEvidence`'s three writes (claim, evidence, event) are NOT wrapped
 *    in one shared database transaction — each of `persistClaim`/
 *    `appendEvidence`/`appendEvent` commits independently. A crash between
 *    steps could leave a claim persisted without its intended evidence/event.
 *    Accepted gap for this task's scope (`createPostgresClaimStoreAdapter`
 *    always opens its own `pool.connect()`-scoped transaction inside
 *    `save()`, so composing it into one larger caller-managed transaction
 *    would require a bigger refactor than this task's file scope allows);
 *    recorded here, not silently omitted. Unrelated to, and not weakened by,
 *    the V1 concurrency fix below (`withSubjectLock`): that fix closes the
 *    cross-WRITER claims-table race (two different callers of `persistClaim`
 *    racing each other), not this same-writer multi-step gap — a crash
 *    between this function's own 3 steps is still possible, still accepted.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  addAuthoredClaim,
  CURRENT_SCHEMA_VERSION,
  generateClaimId,
  updateAuthoredClaim,
  validateClaimStore,
  validateTrustBundle,
  type Claim,
  type ClaimDefinition,
  type ClaimDefinitionDraft,
  type ClaimGroup,
  type ClaimStore,
  type ClaimStoreAdapter,
  type Evidence,
  type ImpactLevel,
  type Materiality,
  type SubjectRef,
  type TrustBundle,
  type VerificationEvent,
  type VerificationPolicy,
} from '@kontourai/surface';

/** Either a bare `Pool` or an already-checked-out `PoolClient` — both expose `.query()`. */
type Queryable = Pool | PoolClient;

// ─── Reserved metadata keys (see header comment gaps 1 and 4) ─────────────

const PRODUCER_METADATA_KEY = '__surfaceStoreProducer';
const CLAIM_GROUP_EXTRA_METADATA_KEY = '__claimGroupExtra';

// ─── Row shapes (mirror migration 012's columns) ──────────────────────────

interface ClaimDefinitionRow {
  id: string;
  subjectType: string;
  subjectId: string;
  facet: string | null;
  claimType: string;
  fieldOrBehavior: string;
  impactLevel: ImpactLevel | null;
  materiality: Materiality | null;
  verificationPolicyId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VerificationPolicyRow {
  id: string;
  claimType: string;
  parentType: string | null;
  requiredEvidence: VerificationPolicy['requiredEvidence'];
  acceptanceCriteria: string[];
  reviewAuthority: string;
  validityRule: VerificationPolicy['validityRule'];
  stalenessTriggers: string[];
  conflictRules: string[];
  impactLevel: ImpactLevel;
}

interface EvidenceRow {
  id: string;
  claimId: string;
  evidenceType: Evidence['evidenceType'];
  method: Evidence['method'];
  sourceRef: string;
  sourceLocator: string | null;
  excerptOrSummary: string;
  observedAt: Date;
  collectedBy: string;
  integrityRef: string | null;
  metadata: Record<string, unknown> | null;
}

interface VerificationEventRow {
  id: string;
  claimId: string;
  status: VerificationEvent['status'];
  type: VerificationEvent['type'] | null;
  actor: string;
  method: string;
  evidenceIds: string[];
  createdAt: Date;
  verifiedAt: Date | null;
  notes: string | null;
  resolvesDispute: boolean | null;
  authorityRef: string | null;
}

interface ClaimGroupRow {
  id: string;
  title: string;
  kind: ClaimGroup['kind'];
  requirements: ClaimGroup['requirements'] | null;
  rollupPolicy: ClaimGroup['rollupPolicy'] | null;
  metadata: Record<string, unknown> | null;
}

// Deliberately excludes "qualifiers": that column mirrors the full `Claim`
// interface's `qualifiers` field (absent from `ClaimDefinition`, per migration
// 012's own header comment), which this task's scope does not populate (see
// header comment gap 5 on `Claim.value` for the same "full Claim reconstruction
// is minimal for now" reasoning) — left NULL, a future wave's concern.
const CLAIM_DEFINITION_COLUMNS = `
  "id", "subjectType", "subjectId", "facet", "claimType", "fieldOrBehavior",
  "impactLevel", "materiality", "verificationPolicyId", "metadata", "createdAt", "updatedAt"
`;

const POLICY_COLUMNS = `
  "id", "claimType", "parentType", "requiredEvidence", "acceptanceCriteria",
  "reviewAuthority", "validityRule", "stalenessTriggers", "conflictRules", "impactLevel"
`;

const EVIDENCE_COLUMNS = `
  "id", "claimId", "evidenceType", "method", "sourceRef", "sourceLocator",
  "excerptOrSummary", "observedAt", "collectedBy", "integrityRef", "metadata"
`;

const EVENT_COLUMNS = `
  "id", "claimId", "status", "type", "actor", "method", "evidenceIds",
  "createdAt", "verifiedAt", "notes", "resolvesDispute", "authorityRef"
`;

const CLAIM_GROUP_COLUMNS = `"id", "title", "kind", "requirements", "rollupPolicy", "metadata"`;

// ─── Row <-> Surface type mapping ──────────────────────────────────────────

function producerFromRow(row: ClaimDefinitionRow | undefined): string | undefined {
  const value = row?.metadata?.[PRODUCER_METADATA_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function claimRowToDefinition(row: ClaimDefinitionRow): ClaimDefinition {
  const raw = row.metadata ?? {};
  const { [PRODUCER_METADATA_KEY]: _producer, ...restMetadata } = raw;
  const metadata = Object.keys(restMetadata).length > 0 ? restMetadata : undefined;
  return {
    id: row.id,
    facet: row.facet ?? undefined,
    claimType: row.claimType,
    fieldOrBehavior: row.fieldOrBehavior,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    impactLevel: row.impactLevel ?? undefined,
    materiality: row.materiality ?? undefined,
    verificationPolicyId: row.verificationPolicyId ?? undefined,
    metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function policyRowToPolicy(row: VerificationPolicyRow): VerificationPolicy {
  return {
    id: row.id,
    claimType: row.claimType,
    parentType: row.parentType ?? undefined,
    requiredEvidence: row.requiredEvidence,
    acceptanceCriteria: row.acceptanceCriteria,
    reviewAuthority: row.reviewAuthority,
    validityRule: row.validityRule,
    stalenessTriggers: row.stalenessTriggers,
    conflictRules: row.conflictRules,
    impactLevel: row.impactLevel,
  };
}

function evidenceRowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    claimId: row.claimId,
    evidenceType: row.evidenceType,
    method: row.method,
    sourceRef: row.sourceRef,
    sourceLocator: row.sourceLocator ?? undefined,
    excerptOrSummary: row.excerptOrSummary,
    observedAt: row.observedAt.toISOString(),
    collectedBy: row.collectedBy,
    integrityRef: row.integrityRef ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

function eventRowToEvent(row: VerificationEventRow): VerificationEvent {
  return {
    id: row.id,
    claimId: row.claimId,
    status: row.status,
    type: row.type ?? undefined,
    actor: row.actor,
    method: row.method,
    evidenceIds: row.evidenceIds,
    createdAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : undefined,
    notes: row.notes ?? undefined,
    resolvesDispute: row.resolvesDispute === true ? true : undefined,
    authorityRef: row.authorityRef ?? undefined,
  };
}

function claimGroupRowToClaimGroup(row: ClaimGroupRow): ClaimGroup {
  const raw = row.metadata ?? {};
  const extra = (raw[CLAIM_GROUP_EXTRA_METADATA_KEY] ?? {}) as { description?: string; claimIds?: string[] };
  const { [CLAIM_GROUP_EXTRA_METADATA_KEY]: _extra, ...restMetadata } = raw;
  const metadata = Object.keys(restMetadata).length > 0 ? restMetadata : undefined;
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    description: extra.description,
    claimIds: extra.claimIds,
    requirements: row.requirements ?? undefined,
    rollupPolicy: row.rollupPolicy ?? undefined,
    metadata,
  };
}

// ─── Fail-loud guards (header comment gaps 2 and 3) ────────────────────────

function assertPolicySupported(policy: VerificationPolicy): void {
  const unsupported: string[] = [];
  if (policy.requiredMethods !== undefined) unsupported.push('requiredMethods');
  if (policy.requiresCorroboration !== undefined) unsupported.push('requiresCorroboration');
  if (policy.collectWhen !== undefined) unsupported.push('collectWhen');
  if (policy.incompatibleValues !== undefined) unsupported.push('incompatibleValues');
  if (policy.incompatibleStatuses !== undefined) unsupported.push('incompatibleStatuses');
  if (unsupported.length > 0) {
    throw new Error(
      `VerificationPolicy "${policy.id}" sets [${unsupported.join(', ')}], which migration 012's ` +
        `"SurfaceVerificationPolicy" table has no column for. Refusing to silently drop this data — ` +
        `extend the migration with the missing column(s) before persisting a policy that sets them.`,
    );
  }
}

function assertEvidenceSupported(evidence: Evidence): void {
  const unsupported: string[] = [];
  if (evidence.supportStrength !== undefined) unsupported.push('supportStrength');
  if (evidence.integrityAnchor !== undefined) unsupported.push('integrityAnchor');
  if (evidence.passing !== undefined) unsupported.push('passing');
  if (evidence.blocking !== undefined) unsupported.push('blocking');
  if (evidence.execution !== undefined) unsupported.push('execution');
  if (unsupported.length > 0) {
    throw new Error(
      `Evidence "${evidence.id}" sets [${unsupported.join(', ')}], which migration 012's ` +
        `"SurfaceEvidence" table has no column for. Refusing to silently drop this data — ` +
        `extend the migration with the missing column(s) before persisting evidence that sets them.`,
    );
  }
}

// ─── Row upserts ────────────────────────────────────────────────────────────

async function upsertPolicyRow(client: Queryable, policy: VerificationPolicy): Promise<void> {
  assertPolicySupported(policy);
  await client.query(
    `INSERT INTO "SurfaceVerificationPolicy" (${POLICY_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT ("id") DO UPDATE SET
       "claimType" = excluded."claimType",
       "parentType" = excluded."parentType",
       "requiredEvidence" = excluded."requiredEvidence",
       "acceptanceCriteria" = excluded."acceptanceCriteria",
       "reviewAuthority" = excluded."reviewAuthority",
       "validityRule" = excluded."validityRule",
       "stalenessTriggers" = excluded."stalenessTriggers",
       "conflictRules" = excluded."conflictRules",
       "impactLevel" = excluded."impactLevel"`,
    [
      policy.id,
      policy.claimType,
      policy.parentType ?? null,
      policy.requiredEvidence,
      policy.acceptanceCriteria,
      policy.reviewAuthority,
      JSON.stringify(policy.validityRule),
      policy.stalenessTriggers,
      policy.conflictRules,
      policy.impactLevel,
    ],
  );
}

async function upsertClaimRow(client: Queryable, claim: ClaimDefinition, producer: string): Promise<void> {
  const metadata = { ...(claim.metadata ?? {}), [PRODUCER_METADATA_KEY]: producer };
  await client.query(
    `INSERT INTO "SurfaceClaimDefinition" (${CLAIM_DEFINITION_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT ("id") DO UPDATE SET
       "subjectType" = excluded."subjectType",
       "subjectId" = excluded."subjectId",
       "facet" = excluded."facet",
       "claimType" = excluded."claimType",
       "fieldOrBehavior" = excluded."fieldOrBehavior",
       "impactLevel" = excluded."impactLevel",
       "materiality" = excluded."materiality",
       "verificationPolicyId" = excluded."verificationPolicyId",
       "metadata" = excluded."metadata",
       "updatedAt" = excluded."updatedAt"`,
    [
      claim.id,
      claim.subjectType,
      claim.subjectId,
      claim.facet ?? null,
      claim.claimType,
      claim.fieldOrBehavior,
      claim.impactLevel ?? null,
      claim.materiality ?? null,
      claim.verificationPolicyId ?? null,
      JSON.stringify(metadata),
      claim.createdAt,
      claim.updatedAt,
    ],
  );
}

// ─── ClaimStoreAdapter — subject-scoped Postgres implementation ────────────

export interface PostgresClaimStoreAdapterOptions {
  readonly pool: Pool;
  readonly subjectType: string;
  readonly subjectId: string;
  /**
   * Default producer used only when `load()` finds no existing rows for this
   * subject (bootstrapping a brand-new, empty store) — matches the file
   * adapter's "empty store on missing file" behavior and the upstream
   * reference's own documented default. Once any rows exist for this
   * subject, `producer` round-trips from what `save()` last persisted (see
   * header comment gap 1); this option has no effect on a store that already
   * has data.
   */
  readonly producer?: string;
  /**
   * INTERNAL — not part of the public `ClaimStoreAdapter` surface. When
   * supplied, `load()`/`save()` run against this already-open, already
   * lock-holding `PoolClient` instead of `pool` (and `save()` does not open
   * its own `BEGIN`/`COMMIT`/advisory-lock/`client.release()`) — the caller
   * (`withSubjectLock`, below) already owns the transaction and this
   * subject's advisory lock for the whole load→modify→save round trip.
   * `persistClaim` is the one caller that sets this (see V1 fix below). A
   * bare `createPostgresClaimStoreAdapter(...)` call (e.g. this module's own
   * standalone adapter round-trip tests, or a caller that only ever calls
   * `save()` once with no preceding `load()`) never sets this and gets the
   * always-safe, self-contained `save()` behavior unchanged.
   */
  readonly client?: PoolClient;
}

/**
 * `@kontourai/surface`'s `ClaimStoreAdapter` (`store.d.ts`), implemented
 * against campfit's migration-012 tables, adapted from
 * `examples/postgres-claim-store/src/postgres-claim-store-adapter.ts`.
 * SUBJECT-SCOPED: constructed for exactly one `(subjectType, subjectId)`
 * pair; `load()`/`save()` only ever see that subject's claims. Policies are
 * not subject-scoped (a policy can be referenced by claims belonging to many
 * subjects) — `save()` upserts the policies the given store references but
 * never deletes a policy just because this subject's claims stopped
 * referencing it.
 */
/**
 * Stable per-subject key fed to `pg_advisory_xact_lock` (via
 * `hashtextextended`, Postgres 11+) — see `withSubjectLock`/V1 fix below.
 * `subjectType`/`subjectId` are concatenated with a `|` separator (matching
 * `session-identity.ts`'s `scheduleNaturalKey` convention) rather than
 * simple string concatenation, so two distinct subjects never collide onto
 * the same lock key (e.g. `subjectType: "ab", subjectId: "c"` vs.
 * `subjectType: "a", subjectId: "bc"`). NUL (`\u0000`) is deliberately NOT
 * used as the separator despite being unambiguous: Postgres `text` values
 * reject it outright (`invalid byte sequence for encoding "UTF8": 0x00`),
 * which would make this query fail loud for every subject, not just a
 * theoretical collision case.
 */
function subjectLockKey(subjectType: string, subjectId: string): string {
  return `${subjectType}|${subjectId}`;
}

/**
 * Runs `fn` inside ONE Postgres transaction that first acquires a
 * `pg_advisory_xact_lock` keyed on `(subjectType, subjectId)` — released
 * automatically at `COMMIT`/`ROLLBACK`, never needs an explicit unlock call.
 *
 * ── V1 fix (CRITICAL, review-code.md) ───────────────────────────────────────
 * `save()`'s "delete every row for this subject not in the given kept-id
 * set" replace semantics (below) is only safe when exactly one writer's
 * load()→modify→save() round trip for a subject is in flight at a time. Two
 * concurrent writers — `mark_verified`, `/attest`, `addFieldAttestation`,
 * `review-apply.ts`'s per-approved-field loop, and the one-time backfill all
 * touch the SAME Camp/Session subject — can otherwise interleave: writer A
 * loads (sees claims {a}), writer B creates+commits a brand-new claim `b`
 * for the same subject, then A's save() runs with its STALE `keptIds = [a]`
 * and deletes `b` — migration 012's `ON DELETE CASCADE` then silently
 * destroys `b`'s entire Evidence/VerificationEvent audit trail with it. No
 * error, no retry signal — unrecoverable data loss for what this whole
 * subsystem's purpose is: an auditable evidence ledger.
 *
 * Locking `save()`'s own transaction (below) alone is not sufficient: it
 * only prevents two `save()` calls from interleaving their WRITES, not a
 * `load()` that already ran (and computed a stale `keptIds`) before either
 * lock was ever taken. The fix has to cover the WHOLE load→modify→save
 * critical section, not just the final write — `persistClaim` (this
 * module's one load-modify-save caller) is the only function that needs
 * this; `withSubjectLock` is what makes its call to `adapter.load()` and
 * `adapter.save()` happen atomically, on the SAME already-locked
 * transaction/client (never two separate connections both trying to take
 * the same advisory lock — that would self-deadlock). Once every writer's
 * load→save cycle for a subject is serialized this way, each new writer's
 * `load()` is GUARANTEED to observe the immediately-prior writer's
 * already-committed claims (the lock cannot be acquired until the previous
 * holder's transaction commits or rolls back), so its own `keptIds` can
 * never omit a claim a concurrent writer just added.
 *
 * `appendEvidence`/`appendEvent` do not need their own lock: they are plain,
 * unconditional `INSERT`s (migration 012: append-only, no delete/no
 * `ON CONFLICT`) — the ONLY mechanism that can ever lose an Evidence/Event
 * row is the claims-table cascade described above, which is now fully
 * closed at its one source (`save()`'s delete-not-in-kept-set query).
 * Locking those two functions independently would add overhead/complexity
 * without closing any additional race.
 */
export async function withSubjectLock<T>(
  pool: Pool,
  subjectType: string,
  subjectId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subjectLockKey(subjectType, subjectId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Factored out of `save()` so both the self-contained and externally-locked code paths share one query sequence. */
async function runClaimStoreSaveQueries(
  client: Queryable,
  subjectType: string,
  subjectId: string,
  validated: ClaimStore,
): Promise<void> {
  // Policies are upserted before claims: "SurfaceClaimDefinition".
  // "verificationPolicyId" carries a foreign key to
  // "SurfaceVerificationPolicy"."id" (migration 012), so a save() that
  // introduces both a new policy and a new claim referencing it in the
  // same call must write the policy first within this transaction.
  for (const policy of validated.policies) {
    await upsertPolicyRow(client, policy);
  }

  // Whole-store save() semantics scoped to this subject: any row for
  // this subject not present in the given store is deleted, matching a
  // full "this is now the claim set for this subject" replace at the
  // port level while staying a cheap, idempotent row-level upsert
  // underneath (natural key = claim id) — mirrors the upstream
  // reference adapter's own documented semantics exactly. Safe under
  // concurrency ONLY because every caller reaching this point already holds
  // this subject's advisory lock for the whole load→modify→save round trip
  // (see `withSubjectLock`'s header comment, V1 fix).
  const keptIds = validated.claims.map((claim) => claim.id);
  await client.query(
    `DELETE FROM "SurfaceClaimDefinition"
      WHERE "subjectType" = $1 AND "subjectId" = $2 AND NOT ("id" = ANY($3))`,
    [subjectType, subjectId, keptIds],
  );

  for (const claim of validated.claims) {
    await upsertClaimRow(client, claim, validated.producer);
  }
}

export function createPostgresClaimStoreAdapter(options: PostgresClaimStoreAdapterOptions): ClaimStoreAdapter {
  const { pool, subjectType, subjectId, client: externalClient } = options;
  const defaultProducer = options.producer ?? 'campfit';

  return {
    name: 'postgres',

    async load(): Promise<ClaimStore> {
      const queryable: Queryable = externalClient ?? pool;
      const { rows: claimRows } = await queryable.query<ClaimDefinitionRow>(
        `SELECT ${CLAIM_DEFINITION_COLUMNS}
           FROM "SurfaceClaimDefinition"
          WHERE "subjectType" = $1 AND "subjectId" = $2
          ORDER BY "id"`,
        [subjectType, subjectId],
      );

      const claims = claimRows.map(claimRowToDefinition);
      const policyIds = [...new Set(claims.map((claim) => claim.verificationPolicyId).filter((id): id is string => Boolean(id)))];
      const policies = policyIds.length === 0 ? [] : await loadPolicies(queryable, policyIds);

      // See header comment gap 1: producer is denormalized onto every claim
      // row for this subject; the first row is authoritative (a single
      // save() call stamps every row it writes with the same value).
      const producer = producerFromRow(claimRows[0]) ?? defaultProducer;

      // load() proves it did not bypass validation, matching the file
      // adapter's behavior (loadClaimStore also runs validateClaimStore).
      return validateClaimStore({ schemaVersion: 1, producer, claims, policies });
    },

    async save(store: ClaimStore): Promise<void> {
      // save() proves it did not bypass validation, matching the file
      // adapter's behavior (saveClaimStore also runs validateClaimStore).
      const validated = validateClaimStore(store);

      const outOfScope = validated.claims.find((claim) => claim.subjectType !== subjectType || claim.subjectId !== subjectId);
      if (outOfScope) {
        throw new Error(
          `Postgres claim store adapter is scoped to subject "${subjectType}:${subjectId}"; ` +
            `refusing to save claim "${outOfScope.id}" for subject "${outOfScope.subjectType}:${outOfScope.subjectId}"`,
        );
      }

      if (externalClient) {
        // Caller (`withSubjectLock`, via `persistClaim`) already holds this
        // subject's advisory lock and owns the surrounding transaction —
        // reuse it rather than opening a second connection, which would
        // deadlock against the very lock this call stack is already holding.
        await runClaimStoreSaveQueries(externalClient, subjectType, subjectId, validated);
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // V1 fix (CRITICAL): see `withSubjectLock`'s header comment above —
        // this makes even a bare, standalone `adapter.save(...)` call (no
        // preceding `persistClaim`/`withSubjectLock`) safe against a
        // concurrent writer of the same subject.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subjectLockKey(subjectType, subjectId)]);
        await runClaimStoreSaveQueries(client, subjectType, subjectId, validated);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

// ─── Campfit's own read/write functions, built on top of the adapter ──────

/** All `ClaimDefinition` rows for a subject type, optionally narrowed to one subject id. */
export async function loadClaimDefinitions(pool: Queryable, subjectType: string, subjectId?: string): Promise<ClaimDefinition[]> {
  const { rows } = subjectId
    ? await pool.query<ClaimDefinitionRow>(
        `SELECT ${CLAIM_DEFINITION_COLUMNS} FROM "SurfaceClaimDefinition" WHERE "subjectType" = $1 AND "subjectId" = $2 ORDER BY "id"`,
        [subjectType, subjectId],
      )
    : await pool.query<ClaimDefinitionRow>(
        `SELECT ${CLAIM_DEFINITION_COLUMNS} FROM "SurfaceClaimDefinition" WHERE "subjectType" = $1 ORDER BY "id"`,
        [subjectType],
      );
  return rows.map(claimRowToDefinition);
}

/** All policies, or only the given ids when supplied. Policies are not subject-scoped. */
export async function loadPolicies(pool: Queryable, ids?: readonly string[]): Promise<VerificationPolicy[]> {
  const { rows } = ids
    ? await pool.query<VerificationPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM "SurfaceVerificationPolicy" WHERE "id" = ANY($1) ORDER BY "id"`, [ids])
    : await pool.query<VerificationPolicyRow>(`SELECT ${POLICY_COLUMNS} FROM "SurfaceVerificationPolicy" ORDER BY "id"`);
  return rows.map(policyRowToPolicy);
}

/**
 * Assembles a `TrustBundle`-shaped object — `{claims, evidence, events,
 * policies, claimGroups}` — for one or more subjects, by reading the
 * normalized tables and reconstructing full `Claim`s from their
 * `ClaimDefinition` row (see header comment gap 5 for why `value` is always
 * `undefined`). The result is exactly what `deriveTrustSnapshot`/
 * `deriveClaimGroupRollups` (`trust-snapshot.d.ts`/`claim-groups.d.ts`)
 * accept, unmodified.
 */
export async function loadClaimBundle(pool: Queryable, subjectRefs: readonly SubjectRef[]): Promise<TrustBundle> {
  if (subjectRefs.length === 0) {
    return validateTrustBundle({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      source: 'campfit.admin.claim-store',
      claims: [],
      evidence: [],
      policies: [],
      events: [],
      claimGroups: [],
    });
  }

  const conditions: string[] = [];
  const params: string[] = [];
  subjectRefs.forEach((ref, index) => {
    conditions.push(`("subjectType" = $${index * 2 + 1} AND "subjectId" = $${index * 2 + 2})`);
    params.push(ref.subjectType, ref.subjectId);
  });

  const { rows: claimRows } = await pool.query<ClaimDefinitionRow>(
    `SELECT ${CLAIM_DEFINITION_COLUMNS} FROM "SurfaceClaimDefinition" WHERE ${conditions.join(' OR ')} ORDER BY "id"`,
    params,
  );

  const definitions = claimRows.map(claimRowToDefinition);
  const claimIds = definitions.map((definition) => definition.id);

  const [evidenceResult, eventResult, claimGroupResult] = await Promise.all([
    claimIds.length > 0
      ? pool.query<EvidenceRow>(`SELECT ${EVIDENCE_COLUMNS} FROM "SurfaceEvidence" WHERE "claimId" = ANY($1) ORDER BY "observedAt"`, [claimIds])
      : Promise.resolve({ rows: [] as EvidenceRow[] }),
    claimIds.length > 0
      ? pool.query<VerificationEventRow>(`SELECT ${EVENT_COLUMNS} FROM "SurfaceVerificationEvent" WHERE "claimId" = ANY($1) ORDER BY "createdAt"`, [claimIds])
      : Promise.resolve({ rows: [] as VerificationEventRow[] }),
    pool.query<ClaimGroupRow>(`SELECT ${CLAIM_GROUP_COLUMNS} FROM "SurfaceClaimGroup" ORDER BY "id"`),
  ]);

  const evidence = evidenceResult.rows.map(evidenceRowToEvidence);
  const events = eventResult.rows.map(eventRowToEvent);
  const claimGroups = claimGroupResult.rows.map(claimGroupRowToClaimGroup);

  const policyIds = [...new Set(definitions.map((definition) => definition.verificationPolicyId).filter((id): id is string => Boolean(id)))];
  const policies = policyIds.length > 0 ? await loadPolicies(pool, policyIds) : [];

  // See header comment gap 5: `value` has no persisted channel in this
  // migration; foldClaim/deriveClaimStatus/deriveTrustSnapshot never consult
  // it for status derivation.
  const claims: Claim[] = definitions.map((definition) => ({ ...definition, value: undefined }));

  return validateTrustBundle({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    source: 'campfit.admin.claim-store',
    claims,
    evidence,
    policies,
    events,
    claimGroups,
  });
}

/**
 * Authors or updates one `ClaimDefinition` for its subject, round-tripping
 * through Surface's own `addAuthoredClaim`/`updateAuthoredClaim`
 * (`claim-authoring.d.ts`, themselves built on `buildClaimDefinition`/
 * `addClaimToStore`/`updateClaimInStore`) on an in-memory reconstruction of
 * the subject's whole store, then persists the result via the adapter's
 * `save()` — never a hand-rolled diff. `draft.id` (or, when omitted,
 * Surface's own deterministic `generateClaimId(subjectId, facet,
 * fieldOrBehavior)` — the same convention `trust-projection.ts`'s
 * `campCanonicalClaimId` already follows) decides create-vs-update.
 */
export async function persistClaim(
  pool: Pool,
  draft: ClaimDefinitionDraft,
  options: { producer?: string; now?: Date | string } = {},
): Promise<ClaimDefinition> {
  // V1 fix (CRITICAL, review-code.md): the whole load()->modify->save()
  // round trip below is this module's one read-modify-write window — see
  // `withSubjectLock`'s header comment for the full mechanism. `client` is
  // handed to the adapter so both its load() and its save() run on the SAME
  // already-locked transaction, never a second connection racing for the
  // same advisory lock.
  return withSubjectLock(pool, draft.subjectType, draft.subjectId, async (client) => {
    return persistClaimOnLockedClient(pool, client, draft, options);
  });
}

/**
 * Persists a Claim while the caller already owns both a database transaction
 * and this subject's advisory lock on `client`. This deliberately never
 * connects, begins, commits, rolls back, or releases; those remain the
 * caller's responsibility so a legacy dual-write can be atomic with the
 * canonical ledger write.
 */
export async function persistClaimOnLockedClient(
  pool: Pool,
  client: PoolClient,
  draft: ClaimDefinitionDraft,
  options: { producer?: string; now?: Date | string } = {},
): Promise<ClaimDefinition> {
  const adapter = createPostgresClaimStoreAdapter({
    pool,
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    producer: options.producer,
    client,
  });

    const store = await adapter.load();
    const claimId = draft.id ?? generateClaimId(draft.subjectId, draft.facet, draft.fieldOrBehavior);
    const existing = store.claims.find((claim) => claim.id === claimId);

    const authored = existing
      ? updateAuthoredClaim(store, claimId, draft, { now: options.now })
      : addAuthoredClaim(store, { ...draft, id: claimId }, { now: options.now });

    // `load()` only returns policies already referenced by an EXISTING claim
    // for this subject (see createPostgresClaimStoreAdapter's header comment)
    // — a claim newly authored (or newly re-pointed) here can reference a
    // policy this particular in-memory store snapshot never pulled in.
    // `validateClaimStore` (run inside `adapter.save()`) requires every
    // `verificationPolicyId` to resolve WITHIN the given store, so it must be
    // fetched and added here before save(), not assumed already present.
    const policyId = authored.claim.verificationPolicyId;
    let storeToSave = authored.store;
    if (policyId && !storeToSave.policies.some((policy) => policy.id === policyId)) {
      const [policy] = await loadPolicies(client, [policyId]);
      if (!policy) {
        throw new Error(
          `Claim "${claimId}" references verificationPolicyId "${policyId}", which does not exist in ` +
            `"SurfaceVerificationPolicy" — call upsertPolicy(pool, policy) before persisting a claim that references it.`,
        );
      }
      storeToSave = { ...storeToSave, policies: [...storeToSave.policies, policy] };
    }

    await adapter.save(storeToSave);
    return authored.claim;
}

/** Acquire the subject lock inside an already-open transaction. */
export async function acquireSubjectAdvisoryLock(client: PoolClient, subjectType: string, subjectId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subjectLockKey(subjectType, subjectId)]);
}

/** Append-only insert of one `Evidence` row (migration 012: corrections are new rows, never mutations). */
export async function appendEvidence(pool: Queryable, evidence: Evidence): Promise<void> {
  assertEvidenceSupported(evidence);
  await pool.query(
    `INSERT INTO "SurfaceEvidence" (${EVIDENCE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      evidence.id,
      evidence.claimId,
      evidence.evidenceType,
      evidence.method,
      evidence.sourceRef,
      evidence.sourceLocator ?? null,
      evidence.excerptOrSummary,
      evidence.observedAt,
      evidence.collectedBy,
      evidence.integrityRef ?? null,
      evidence.metadata ? JSON.stringify(evidence.metadata) : null,
    ],
  );
}

/** Append-only insert of one `VerificationEvent` row (the status-bearing ledger). */
export async function appendEvent(pool: Queryable, event: VerificationEvent): Promise<void> {
  await pool.query(
    `INSERT INTO "SurfaceVerificationEvent" (${EVENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      event.id,
      event.claimId,
      event.status,
      event.type ?? null,
      event.actor,
      event.method,
      event.evidenceIds,
      event.createdAt,
      event.verifiedAt ?? null,
      event.notes ?? null,
      event.resolvesDispute === true ? true : null,
      event.authorityRef ?? null,
    ],
  );
}

/** Upserts one `VerificationPolicy` row directly (not subject-scoped — see `createPostgresClaimStoreAdapter`'s header comment). */
export async function upsertPolicy(pool: Queryable, policy: VerificationPolicy): Promise<void> {
  await upsertPolicyRow(pool, policy);
}

/** Upserts one `ClaimGroup` row (Verified Camp / Verified Session claim sets land here as policy data — a later wave). */
export async function upsertClaimGroup(pool: Queryable, group: ClaimGroup): Promise<void> {
  const metadata: Record<string, unknown> = { ...(group.metadata ?? {}) };
  if (group.description !== undefined || group.claimIds !== undefined) {
    metadata[CLAIM_GROUP_EXTRA_METADATA_KEY] = {
      ...(group.description !== undefined ? { description: group.description } : {}),
      ...(group.claimIds !== undefined ? { claimIds: group.claimIds } : {}),
    };
  }

  await pool.query(
    `INSERT INTO "SurfaceClaimGroup" (${CLAIM_GROUP_COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("id") DO UPDATE SET
       "title" = excluded."title",
       "kind" = excluded."kind",
       "requirements" = excluded."requirements",
       "rollupPolicy" = excluded."rollupPolicy",
       "metadata" = excluded."metadata"`,
    [
      group.id,
      group.title,
      group.kind,
      group.requirements ? JSON.stringify(group.requirements) : null,
      group.rollupPolicy ? JSON.stringify(group.rollupPolicy) : null,
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
    ],
  );
}

/**
 * The one interface both attestation stores (crawl-review and human
 * attestation) reconcile behind (see the plan's "recordEvidence" narrative):
 * ensures the `ClaimDefinition` row exists (authoring it if new), appends
 * the `Evidence` row, then appends a `VerificationEvent` row. When `event`
 * is omitted, one is synthesized with a conservative default status —
 * `'verified'` for direct human attestation evidence (`method: 'attestation'`),
 * `'assumed'` otherwise (e.g. machine-extracted evidence awaiting review) —
 * mirroring the verified/assumed split `trust-projection.ts`'s Survey
 * `reviewOutcome.status` conventions already use elsewhere in this repo.
 * Callers that need a different status (e.g. `'disputed'`) must pass `event`
 * explicitly.
 */
export async function recordEvidence(
  pool: Pool,
  input: { claim: ClaimDefinitionDraft; evidence: Evidence; event?: VerificationEvent },
): Promise<void> {
  await recordEvidenceUsing(pool, input, (draft) => persistClaim(pool, draft));
}

async function recordEvidenceUsing(
  queryable: Queryable,
  input: { claim: ClaimDefinitionDraft; evidence: Evidence; event?: VerificationEvent },
  persist: (draft: ClaimDefinitionDraft) => Promise<ClaimDefinition>,
): Promise<void> {
  const claim = await persist(input.claim);
  const evidence: Evidence = { ...input.evidence, claimId: claim.id };
  await appendEvidence(queryable, evidence);

  const event: VerificationEvent = input.event
    ? { ...input.event, claimId: claim.id }
    : {
        id: `event.${evidence.id}.${randomUUID()}`,
        claimId: claim.id,
        status: evidence.method === 'attestation' ? 'verified' : 'assumed',
        actor: evidence.collectedBy,
        method: evidence.method,
        evidenceIds: [evidence.id],
        createdAt: new Date().toISOString(),
      };
  await appendEvent(queryable, event);
}

/**
 * Transaction-owning counterpart to `recordEvidence`. The caller must have
 * acquired the Claim subject's advisory lock on `client`; no connection or
 * transaction boundary is created here.
 */
export async function recordEvidenceOnLockedClient(
  pool: Pool,
  client: PoolClient,
  input: { claim: ClaimDefinitionDraft; evidence: Evidence; event?: VerificationEvent },
): Promise<void> {
  await recordEvidenceUsing(client, input, (draft) => persistClaimOnLockedClient(pool, client, draft));
}
