/**
 * session-metrics.mjs — Driving Session 1 oversight metrics
 *
 * Reads all SurveyReviewEvent rows for proposals tagged 'driving-session-1',
 * replays the decisions via @kontourai/survey, and prints oversight stats
 * including overrideRate and typedRationaleRate — computed from YOUR actual
 * session decisions.
 *
 * Usage (after running the driving session):
 *   node scripts/session-metrics.mjs
 *
 * Or filter to one proposal:
 *   node scripts/session-metrics.mjs <proposalId>
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load env
function loadEnv(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
      if (match) process.env[match[1]] ??= match[2];
    }
  } catch { /* no file */ }
}
loadEnv(join(__dirname, '..', '.env.local'));
loadEnv(join(__dirname, '..', '.env'));

// Parse DATABASE_URL
function parseConnectionString(connectionString) {
  const match = connectionString?.match(/^postgres(?:ql)?:\/\/(.+)$/i);
  if (!match) return null;
  const body = match[1];
  const atIndex = body.lastIndexOf('@');
  const authPart = body.slice(0, atIndex);
  const locationPart = body.slice(atIndex + 1);
  const authSep = authPart.indexOf(':');
  const user = decodeURIComponent(authPart.slice(0, authSep));
  const password = decodeURIComponent(authPart.slice(authSep + 1));
  const slashIndex = locationPart.indexOf('/');
  const hostPort = locationPart.slice(0, slashIndex);
  const databasePart = locationPart.slice(slashIndex + 1);
  const hostSep = hostPort.lastIndexOf(':');
  const host = hostSep === -1 ? hostPort : hostPort.slice(0, hostSep);
  const port = hostSep === -1 ? 6543 : parseInt(hostPort.slice(hostSep + 1), 10);
  const database = databasePart.split(/[?#]/, 1)[0] || 'postgres';
  return { host, port, database, user, password };
}

const { Pool } = require(join(__dirname, '..', 'node_modules', 'pg'));
const cfg = parseConnectionString(process.env.DATABASE_URL);
if (!cfg) { console.error('DATABASE_URL not set or unparseable'); process.exit(1); }

const pool = new Pool({ ...cfg, ssl: { rejectUnauthorized: false }, max: 2 });

const targetProposalId = process.argv[2] ?? null;

async function main() {
  // Fetch driving-session proposals
  const proposalFilter = targetProposalId
    ? `AND p.id = '${targetProposalId}'`
    : `AND 'driving-session-1' = ANY(p."feedbackTags")`;

  const proposals = await pool.query(`
    SELECT p.id AS "proposalId", c.name AS "campName", p.status,
           p."feedbackTags"
    FROM "CampChangeProposal" p
    JOIN "Camp" c ON c.id = p."campId"
    WHERE 1=1 ${proposalFilter}
    ORDER BY c.name
  `);

  if (proposals.rows.length === 0) {
    console.log('No driving-session-1 proposals found.');
    console.log('Run: npm run seed:driving-session  then complete your review session first.');
    await pool.end();
    return;
  }

  // Fetch all review sessions + events for these proposals
  const proposalIds = proposals.rows.map(r => r.proposalId);
  const placeholders = proposalIds.map((_, i) => `$${i + 1}`).join(', ');

  const sessions = await pool.query(
    `SELECT rs.id, rs."proposalId", rs.snapshot
     FROM "SurveyReviewSession" rs
     WHERE rs."proposalId" IN (${placeholders})`,
    proposalIds,
  );

  const events = await pool.query(
    `SELECT e."proposalId", e."reviewSessionId", e.event
     FROM "SurveyReviewEvent" e
     WHERE e."proposalId" IN (${placeholders})
     ORDER BY e."proposalId", e."reviewSessionId", e.sequence ASC`,
    proposalIds,
  );

  // Group events by proposalId + sessionId
  const eventsByKey = {};
  for (const row of events.rows) {
    const key = `${row.proposalId}:${row.reviewSessionId}`;
    (eventsByKey[key] ??= []).push(row.event);
  }

  // ── Derive oversight metrics from events ──────────────────────────────────
  // Compute from the ReviewSessionEvent stream (no deriveOversightMetrics in SDK yet):
  //   overrideRate        = decisions where action === 'typed' / total decided
  //   typedRationaleRate  = decisions where rationale is non-empty / total decided

  let totalDecisions = 0;
  let typedActionCount = 0;    // action === 'typed' (reviewer typed rationale text)
  let withRationaleCount = 0;  // rationale field non-empty on decision events
  let acceptCount = 0;
  let keepCurrentCount = 0;
  let unresolvedProposals = 0;
  let proposalBreakdown = [];

  for (const proposalRow of proposals.rows) {
    const session = sessions.rows.find(s => s.proposalId === proposalRow.proposalId);
    if (!session) {
      unresolvedProposals++;
      proposalBreakdown.push({
        campName: proposalRow.campName,
        status: 'NO_SESSION',
        decisions: 0,
        typed: 0,
      });
      continue;
    }

    const key = `${proposalRow.proposalId}:${session.id}`;
    const sessionEvents = eventsByKey[key] ?? [];
    const snapshot = session.snapshot;

    // Tally decision-changed events
    const decisionEvents = sessionEvents.filter(e =>
      e.spec?.eventType === 'decision-changed' || e.spec?.eventType === 'decision-submitted',
    );

    // Determine effective final decisions per item (last decision-changed per item)
    const finalDecisions = {};
    for (const evt of sessionEvents) {
      if ((evt.spec?.eventType === 'decision-changed' || evt.spec?.eventType === 'decision-submitted')
          && evt.spec?.reviewItemName) {
        finalDecisions[evt.spec.reviewItemName] = {
          status: evt.spec.status,
          rationale: evt.spec.rationale ?? '',
        };
      }
    }

    const decisionCount = Object.keys(finalDecisions).length;
    totalDecisions += decisionCount;

    // Typed-rationale: any non-empty rationale on a final decision
    const typed = Object.values(finalDecisions).filter(d => d.rationale && d.rationale.trim().length > 0).length;
    withRationaleCount += typed;

    // For overrideRate we look at the authorizing block on the ReviewDecision.
    // In the event stream this is captured on decision-submitted events.
    const submittedDecisions = sessionEvents.filter(e => e.spec?.eventType === 'decision-submitted');
    let propTypedAction = 0;
    for (const evt of submittedDecisions) {
      // The workbench sets action='typed' when the note field was non-empty
      // Otherwise it sets action='affirmed-control'
      if (evt.spec?.data?.authorizing?.action === 'typed' ||
          (evt.spec?.rationale && evt.spec.rationale.trim().length > 0)) {
        propTypedAction++;
      }
    }
    typedActionCount += propTypedAction;

    // Accept vs keep-current tallies
    for (const d of Object.values(finalDecisions)) {
      if (d.status === 'verified') acceptCount++;
      // keep-current is: decision for keep-current, which maps to a "verified" status on the current candidate
      // We can't fully distinguish accept vs keep-current from status alone without the full items,
      // so we tally via decisionsByItemName from snapshot if available
    }

    // Better: use snapshot.decisionsByItemName if that's replayed into the snapshot after events
    // The snapshot doesn't store decisions — they're in events.
    // We approximate by counting 'verified' status on proposed-role events

    // Count by reviewing note-changed events for non-empty note entries (typed rationale signal)
    const noteEvents = sessionEvents.filter(e =>
      e.spec?.eventType === 'note-changed' && e.spec?.rationale && e.spec.rationale.trim().length > 0,
    );
    // noteEvents already counted in typed above if they flow through decision-changed

    const resolved = decisionCount;
    const proposalItems = snapshot?.items?.length ?? '?';
    proposalBreakdown.push({
      campName: proposalRow.campName,
      status: proposalRow.status,
      items: proposalItems,
      resolvedDecisions: resolved,
      typedRationales: typed,
      events: sessionEvents.length,
    });
  }

  // ── Output ────────────────────────────────────────────────────────────────

  const overrideRate = totalDecisions > 0 ? (typedActionCount / totalDecisions) : null;
  const typedRationaleRate = totalDecisions > 0 ? (withRationaleCount / totalDecisions) : null;

  console.log('');
  console.log('=== Driving Session 1 — Oversight Metrics ===');
  console.log('');
  console.log(`Proposals reviewed : ${proposals.rows.length}`);
  console.log(`Total decisions    : ${totalDecisions}`);
  console.log(`Accepts            : ${acceptCount}`);
  console.log(`Unresolved proposals: ${unresolvedProposals} (no session started yet)`);
  console.log('');

  if (totalDecisions === 0) {
    console.log('No decisions recorded yet — complete your review session first.');
    console.log('Visit: http://localhost:3000/admin/review');
    console.log('Filter by tag: driving-session-1');
  } else {
    const pct = (v) => v != null ? `${(v * 100).toFixed(0)}%` : 'n/a';
    console.log(`typedRationaleRate : ${pct(typedRationaleRate)}  (${withRationaleCount}/${totalDecisions} decisions had typed rationale)`);
    console.log(`overrideRate       : ${pct(overrideRate)}  (typed action / total; NOTE: requires submitted decisions to compute precisely)`);
    console.log('');
    console.log('Note: overrideRate in the SDK sense (action="typed" vs "affirmed-control") is recorded');
    console.log('on the authorizing block of each ReviewDecision after submit. The value above');
    console.log("approximates it from rationale presence. After you apply proposals, run:");
    console.log('  npm run verify:survey  to see a full TrustBundle claim snapshot.');
  }

  console.log('');
  console.log('Per-proposal breakdown:');
  for (const p of proposalBreakdown) {
    const flags = [];
    if (p.typedRationales > 0) flags.push(`${p.typedRationales} typed rationale(s)`);
    console.log(`  ${p.campName.padEnd(40)} status=${p.status} items=${p.items ?? '?'} decisions=${p.resolvedDecisions ?? 0} ${flags.join(' ')}`);
  }

  console.log('');
  console.log('=== Where to see authorizing blocks ===');
  console.log('After applying a proposal:');
  console.log("  GET /api/admin/review/<proposalId>/survey-events?reviewSessionId=<sessionId>");
  console.log('  Look for events where spec.eventType === "decision-submitted"');
  console.log('  The spec.data.authorizing field contains: { action: "typed"|"affirmed-control", ... }');
  console.log('');
  console.log('Or in the SurveyReviewEvent table:');
  console.log("  SELECT event->'spec'->'data'->'authorizing' FROM \"SurveyReviewEvent\"");
  console.log("    WHERE event->'spec'->>'eventType' = 'decision-submitted';");

  await pool.end();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
