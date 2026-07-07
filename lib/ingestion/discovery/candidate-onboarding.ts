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
 * error type for the same failure mode). Post-review fix (campfit#93 H2):
 * `findProviderByDomain`/`createProvider` are now called with THIS function's
 * own locked `client` (see `lib/admin/provider-repository.ts`'s additive
 * `executor` parameter) so the Provider write genuinely joins the
 * candidate-row transaction — a mid-flight failure between the two rolls
 * BOTH back, leaving no orphaned Provider.
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
  /**
   * campfit#93 H1 defense-in-depth: when provided, the locked candidate row's
   * `aggregatorSourceId` must match exactly, or the whole onboard is rejected
   * (`CandidateAggregatorMismatchError`) before any Provider is created. The
   * route (`app/api/admin/aggregators/[id]/candidates/onboard/route.ts`) is
   * the primary enforcement layer (it rejects a mismatch before ever calling
   * this function); this guard exists so the same rule holds even if a
   * future caller forgets that check — mirrors the ToS gate's own
   * route-level + repository-level dual-layer pattern.
   */
  expectedAggregatorSourceId?: string;
}

export interface OnboardCandidateResult {
  providerId: string;
  providerSlug: string;
  /** `false` when onboarding matched an existing Provider instead of creating one. */
  providerCreated: boolean;
}

/**
 * Thrown when `opts.expectedAggregatorSourceId` is given and does not match
 * the locked candidate row's own `aggregatorSourceId` — the repository-level
 * half of campfit#93 H1's authorization-boundary fix.
 *
 * Review fix (campfit#93 iter2 L): the message deliberately names only the
 * candidate id and the EXPECTED aggregator id (already known to the caller
 * from the URL) — never `actualAggregatorSourceId` (the OTHER aggregator's
 * id, still preserved as a structured field below for any caller that wants
 * it). If this error ever became route-reachable via a generic catch (see
 * the onboard route's own `err.message` passthrough), a foreign aggregator's
 * id must not leak into the response body.
 */
export class CandidateAggregatorMismatchError extends Error {
  constructor(
    public readonly candidateId: string,
    public readonly expectedAggregatorSourceId: string,
    public readonly actualAggregatorSourceId: string | null,
  ) {
    super(
      `Candidate ${candidateId} does not belong to aggregator ${expectedAggregatorSourceId}; refusing to onboard.`,
    );
    this.name = "CandidateAggregatorMismatchError";
  }
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
    if (
      opts.expectedAggregatorSourceId !== undefined &&
      candidate.aggregatorSourceId !== opts.expectedAggregatorSourceId
    ) {
      throw new CandidateAggregatorMismatchError(
        candidateId,
        opts.expectedAggregatorSourceId,
        candidate.aggregatorSourceId,
      );
    }
    if (candidate.status !== "PENDING") {
      throw new CandidateNotPendingError(candidate.status);
    }

    // `findProviderByDomain`/`createProvider` (lib/admin/provider-repository.ts,
    // campfit#90) accept an additive `executor` override (campfit#93 H2) —
    // passing THIS function's own locked `client` here makes the Provider
    // write join the SAME transaction as the candidate-row lock, so a
    // mid-flight failure (crash, timeout, dropped connection) between
    // `createProvider` succeeding and this transaction's `COMMIT` rolls the
    // Provider insert back too. No orphaned duplicate Provider is possible,
    // even for a domain-less candidate that a retry could not otherwise
    // dedupe against.
    const domain = parseDomain(candidate.websiteUrl);
    const existing = domain ? await findProviderByDomain(domain, client) : null;

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
      }, client);
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
