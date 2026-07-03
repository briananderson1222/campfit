# T3 Verified-Coverage Threshold — Recommendation (Proposal)

> **Status: PROPOSAL for the owner (Brian) to ratify.** This document recommends
> the verified-coverage threshold that opens the camp.fit user-acquisition gate.
> Nothing here changes product behavior — issue #48 (I21) ships the honest
> display and the metric; this is the number that metric should be measured
> against. The threshold is a business/quality decision, not an engineering one,
> so it is written as a recommendation to accept, adjust, or reject.

## What the gate metric measures

`getVerifiedCoverageMetric()` (`lib/admin/metrics-repository.ts`) reports the
count and percentage of camps that are **fully verified** — meaning every one of
the nine `REQUIRED_FOR_VERIFIED` fields (`lib/admin/verification.ts`) has an
explicit attestation (`fieldSources[field].approvedAt`). This is the exact
`isFullyVerified()` rule already enforced at the admin approve gate, so the badge
on the site, the ranking, and this metric can never disagree about what
"verified" means.

Required fields (all nine must be attested for VERIFIED):
`description`, `campType`, `category`, `registrationStatus`, `city`,
`websiteUrl`, `ageGroups`, `pricing`, `schedules`.

## Starting reality

Current verified coverage is **~0%**. Almost no camp has all nine fields
attested today (coverage is driven by admin review / crawl approvals, which have
only just been productized). Two consequences shape the recommendation:

1. A strict "all camps verified" gate would keep acquisition closed
   indefinitely and is not actionable.
2. Honesty is **already handled** by I21/#48: every unverified claim is visibly
   distinguished (R1) and verified content ranks first (R2). So showing
   unverified data is safe. The threshold therefore governs *paid-growth
   quality* — a first-time visitor's first impression — not safety.

## Recommended field classes

Split the nine required fields into two classes to allow an honest interim
"usable" bar while keeping full VERIFIED strict:

- **Tier A — findable, fit, actionable (6):** `city`, `websiteUrl`,
  `registrationStatus`, `ageGroups`, `schedules`, `pricing`. With these a parent
  can find the camp, judge age fit, see cost, and act.
- **Tier B — descriptive (3):** `description`, `campType`, `category`.

Full **VERIFIED** (the badge, the metric) continues to require **all nine** —
Tier A/B is only a lens for staging the ramp, not a relaxation of the badge.

## Recommended threshold (T3)

Open the user-acquisition gate when:

> **≥ 60% of the camps in the *default view* are fully VERIFIED**, measured on
> the default-ranked result set (first browse page / top search results), **not**
> the whole catalog.

Measuring on the default view (what a new visitor actually sees first), combined
with verified-first ranking (R2), means the gate reflects the real first
impression rather than the long tail.

### Recommended ramp

| Stage | Bar | Action |
| --- | --- | --- |
| 0 (now) | ~0% | Honest display live (#48). No paid acquisition. |
| 1 | ≥ 25% of default view Tier-A-complete | Internal validation / organic only. |
| 2 (**T3**) | **≥ 60% of default view fully VERIFIED** | Open the user-acquisition gate. |
| 3 | ≥ 85% of default view fully VERIFIED | Unlock the consumer "verified by CampFit" badge (I12). |

## Rationale

- **Grounded in ~0% today:** an absolute all-catalog bar is unreachable soon; a
  default-view bar is movable by prioritizing review of the camps most visitors
  land on first.
- **Safety is decoupled from the number:** R1 guarantees no unverified claim is
  shown as verified, so the threshold can be a growth-quality lever set by the
  owner rather than a safety floor.
- **60%** means a new visitor's initial impression is majority-confirmed while
  the long tail stays honestly labeled and still discoverable.
- **Single source of truth:** because the metric reuses `REQUIRED_FOR_VERIFIED`
  and `isFullyVerified()`, ratifying a percentage is the only open decision —
  the definition of "verified" is already fixed in code.

## Decision requested

Please ratify, adjust, or reject: (a) the **60% of default view** T3 threshold,
(b) the **Tier A / Tier B** field classes, and (c) the **ramp stages**. Once
ratified, the admin dashboard's Verified Coverage panel is the number to watch
against it.
