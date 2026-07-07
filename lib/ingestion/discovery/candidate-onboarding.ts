/**
 * lib/ingestion/discovery/candidate-onboarding.ts — the hardened onboarding
 * path for a `ProviderCandidate` (campfit#93, R4/AC4).
 *
 * `onboardProviderCandidate` is deliberately a NEW sibling to
 * `approveProviderCandidate` (candidate-repository.ts), not a call site of it.
 * `approveProviderCandidate` predates campfit#90 and still runs its own ad hoc
 * `INSERT INTO "Provider"` with no domain-dedupe check — reusing it here would
 * silently reintroduce the pre-#90 duplicate-domain/validation gap for every
 * aggregator-sourced onboard. This function instead calls the campfit#90
 * hardened path directly: `findProviderByDomain` (re-checked at onboard time,
 * since a domain match may have appeared since the candidate was discovered)
 * and `createProvider` (lib/admin/provider-repository.ts), the SAME functions
 * `POST /api/admin/providers` uses.
 *
 * Transaction discipline mirrors `approveProviderCandidate` exactly: the
 * candidate row is locked (`FOR UPDATE`) and re-verified `PENDING` inside the
 * same transaction, so a candidate can be onboarded at most once (a second
 * call throws the EXISTING `CandidateNotPendingError`, reused as-is — no new
 * error type for the same failure mode).
 */
import type { Pool } from "pg";

import { getPool } from "@/lib/db";
import { parseDomain } from "@/lib/admin/onboarding-validation";
import { createProvider, findProviderByDomain } from "@/lib/admin/provider-repository";
import type { Provider } from "@/lib/types";
import {
  CandidateNotPendingError,
  type ProviderCandidateRow,
} from "./candidate-repository";

export interface OnboardCandidateOptions {
  onboardedBy: string;
}

export interface OnboardCandidateResult {
  providerId: string;
  providerSlug: string;
  /** `false` when onboarding matched an existing Provider instead of creating one. */
  providerCreated: boolean;
}

/**
 * Locks the candidate row, verifies `PENDING`, then either points the
 * candidate at a Provider whose domain already matches (no duplicate row) or
 * creates a new Provider via campfit#90's hardened path — never via
 * `approveProviderCandidate`'s own raw insert. Marks the candidate `APPROVED`
 * with `approvedProviderId`/`reviewedAt`/`reviewedBy` either way, exactly like
 * `approveProviderCandidate` does, so the two write paths remain
 * indistinguishable from the candidate-row side.
 */
export async function onboardProviderCandidate(
  candidateId: string,
  opts: OnboardCandidateOptions,
  pool: Pool = getPool(),
): Promise<OnboardCandidateResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: locked } = await client.query<ProviderCandidateRow>(
      `SELECT * FROM "ProviderCandidate" WHERE id = $1 FOR UPDATE`,
      [candidateId],
    );
    const candidate = locked[0];
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found`);
    }
    if (candidate.status !== "PENDING") {
      throw new CandidateNotPendingError(candidate.status);
    }

    // `findProviderByDomain`/`createProvider` (lib/admin/provider-repository.ts,
    // campfit#90) always run against the shared `getPool()` singleton — they
    // take no pool/client override — so they cannot join this function's own
    // candidate-row transaction. That mirrors how `POST /api/admin/providers`
    // already calls them (a single implicit-transaction statement each), and
    // keeps this function from having to fork/modify the hardened #90 path
    // just to thread a client through it.
    const domain = parseDomain(candidate.websiteUrl);
    const existing = domain ? await findProviderByDomain(domain) : null;

    let providerId: string;
    let providerSlug: string;
    let providerCreated: boolean;

    if (existing) {
      providerId = existing.id;
      providerSlug = existing.slug;
      providerCreated = false;
    } else {
      const provider: Provider = await createProvider({
        name: candidate.name,
        websiteUrl: candidate.websiteUrl,
        city: candidate.city,
        neighborhood: candidate.neighborhood,
        notes: `Onboarded from aggregator candidate "${candidate.name}" (source: ${candidate.sourceLabel}).`,
        crawlRootUrl: candidate.websiteUrl,
        communitySlug: candidate.communitySlug,
      });
      providerId = provider.id;
      providerSlug = provider.slug;
      providerCreated = true;
    }

    await client.query(
      `UPDATE "ProviderCandidate"
         SET status = 'APPROVED', "approvedProviderId" = $2,
             "reviewedAt" = now(), "reviewedBy" = $3
       WHERE id = $1`,
      [candidateId, providerId, opts.onboardedBy],
    );

    await client.query("COMMIT");
    return { providerId, providerSlug, providerCreated };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
