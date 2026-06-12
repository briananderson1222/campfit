/**
 * dry-run-driving-session.ts
 * Simulates 5 review decisions against the seeded driving-session proposals via API.
 * Run: npm run dry-run:driving-session
 */
import fs from 'fs';
import { loadLocalEnv } from './load-env.ts';
loadLocalEnv();

import { getPool } from '../lib/db.ts';
import {
  buildReviewSessionEvents,
} from '@kontourai/survey/review-workbench';

async function main() {
  const pool = getPool();
  const authStatePath = 'test-results/.auth/admin.json';

  if (!fs.existsSync(authStatePath)) {
    console.error('Auth state not found. Run: npx playwright test tests/browser/auth.setup.ts');
    process.exit(1);
  }

  const authState = JSON.parse(fs.readFileSync(authStatePath, 'utf8'));
  const cookieHeader = authState.cookies
    .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
    .join('; ');
  const baseUrl = 'http://127.0.0.1:3100';

  const headers: Record<string, string> = {
    'Cookie': cookieHeader,
    'Content-Type': 'application/json',
  };

  const proposals = await pool.query<{ proposalId: string; campName: string }>(`
    SELECT p.id AS "proposalId", c.name AS "campName"
    FROM "CampChangeProposal" p
    JOIN "Camp" c ON c.id = p."campId"
    WHERE p.status = 'PENDING' AND 'driving-session-1' = ANY(p."feedbackTags")
    ORDER BY c.name
    LIMIT 5
  `);

  console.log(`Dry-running ${proposals.rows.length} proposals...\n`);

  const results: { campName: string; events: number; authorizing: string[] }[] = [];

  for (const { proposalId, campName } of proposals.rows) {
    console.log(`[${campName}] (${proposalId})`);

    // Load the review page to trigger session creation via server component
    const pageResp = await fetch(`${baseUrl}/admin/review/${proposalId}`, { headers });
    if (!pageResp.ok) {
      console.log(`  page load: ${pageResp.status} — skipping`);
      continue;
    }
    console.log(`  page: ${pageResp.status}`);

    // Check for session in DB
    const sessionRow = await pool.query<{
      id: string;
      snapshot: { items: Array<{ metadata: { name: string }; spec: { target: string } }> };
      sessionName: string;
      updatedAt: string;
    }>(
      `SELECT id, snapshot, "sessionName", "updatedAt" FROM "SurveyReviewSession" WHERE "proposalId" = $1`,
      [proposalId],
    );
    if (!sessionRow.rows[0]) {
      console.log(`  no session found — skipping`);
      continue;
    }
    const { id: reviewSessionId, snapshot } = sessionRow.rows[0];
    const items = snapshot.items ?? [];
    console.log(`  session: ${reviewSessionId} items: ${items.length}`);

    // Existing event count
    const existingEvtResp = await fetch(
      `${baseUrl}/api/admin/review/${proposalId}/survey-events?reviewSessionId=${reviewSessionId}`,
      { headers },
    );
    const { events: existingEvents } = await existingEvtResp.json() as { events: unknown[] };

    // Build decisions: mixed — accept first, keep-current second with note, accept rest
    const decisionsByItemName: Record<string, 'accept-proposed' | 'keep-current'> = {};
    const notesByItemName: Record<string, string> = {};

    items.forEach((item, idx) => {
      if (idx === 1) {
        decisionsByItemName[item.metadata.name] = 'keep-current';
        notesByItemName[item.metadata.name] = `Source too vague for '${item.spec.target}' — keeping current until clearer evidence.`;
      } else {
        decisionsByItemName[item.metadata.name] = 'accept-proposed';
      }
    });

    const simulatedSession = { ...snapshot, decisionsByItemName, notesByItemName };
    const newEvents = buildReviewSessionEvents(simulatedSession);

    const putResp = await fetch(
      `${baseUrl}/api/admin/review/${proposalId}/survey-events`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ events: newEvents, reviewSessionId, expectedEventCount: existingEvents.length }),
      },
    );
    const putBody = await putResp.json() as { count?: number; error?: string };
    if (!putResp.ok) {
      console.log(`  PUT failed ${putResp.status}: ${putBody.error}`);
      continue;
    }
    console.log(`  persisted ${putBody.count} events`);

    // Verify and inspect authorizing
    const verifyResp = await fetch(
      `${baseUrl}/api/admin/review/${proposalId}/survey-events?reviewSessionId=${reviewSessionId}`,
      { headers },
    );
    const { events: savedEvents } = await verifyResp.json() as { events: Array<{
      spec?: { eventType?: string; data?: { authorizing?: { action?: string; promptRef?: string } }; rationale?: string }
    }> };

    const authorizingCodes: string[] = [];
    for (const evt of savedEvents) {
      if (evt.spec?.eventType === 'decision-submitted') {
        const action = evt.spec?.data?.authorizing?.action ?? 'unknown';
        const rationale = evt.spec?.rationale ?? '';
        authorizingCodes.push(`action=${action}${rationale ? ' (typed-rationale)' : ''}`);
        console.log(`  decision-submitted: action=${action} promptRef=${evt.spec?.data?.authorizing?.promptRef}`);
      }
    }
    results.push({ campName, events: savedEvents.length, authorizing: authorizingCodes });
  }

  console.log('\n=== Dry-run summary ===');
  for (const r of results) {
    console.log(`  ${r.campName}: ${r.events} events, authorizing=[${r.authorizing.join(', ')}]`);
  }

  // Run metrics
  console.log('\n=== Metrics preview ===');
  console.log('Run: node scripts/session-metrics.mjs');

  process.exit(0);
}
main().catch(e => { console.error('Dry-run error:', e.message); process.exit(1); });
