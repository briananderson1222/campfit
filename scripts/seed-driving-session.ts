/**
 * seed-driving-session.ts
 *
 * Seeds 6 realistic CampChangeProposal rows for the driving-session-1 founder demo.
 * Each proposal is attached to an existing Camp row in the 'denver' community.
 *
 * Design intent — mixed decision prompts:
 *   1. Aerial Cirque — description + ageRange clearly good to accept
 *   2. Altitude All Sports — registrationStatus + contactPhone: clear accept (high confidence + matching excerpt)
 *   3. Apex Music Camp — pricing: clear accept (was empty, confident extract)
 *   4. Art Garage — registrationStatus: OPEN → WAITLIST with low confidence + ambiguous source — genuinely ambiguous
 *   5. Art Camp with Matty Miller — name: minor cleanup obviously right, + contactEmail populate
 *   6. Avid 4 Adventure — description update: old content is fine, new is marginal — keep-current case
 *
 * Run: npm run seed:driving-session
 * Idempotent: won't re-seed if proposals for these camps already exist (tagged ds1).
 */

import { loadLocalEnv } from './load-env.ts';
loadLocalEnv();

import { getPool } from '../lib/db.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Proposal definitions
// ──────────────────────────────────────────────────────────────────────────────

interface ProposalDef {
  campSlug: string;
  sourceUrl: string;
  overallConfidence: number;
  feedbackTags: string[];
  extractionModel: string;
  proposedChanges: Record<string, {
    old: unknown;
    new: unknown;
    confidence: number;
    excerpt: string;
    sourceUrl: string;
    mode: 'update' | 'populate' | 'add_items';
  }>;
  drivingNote: string; // for console only
}

const PROPOSALS: ProposalDef[] = [
  {
    campSlug: 'aerial-cirque-over-denver',
    sourceUrl: 'https://aerialcirqueoverdenver.com/aerial-camps/',
    overallConfidence: 0.95,
    feedbackTags: [],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'ACCEPT both — high confidence, clear improvements',
    proposedChanges: {
      description: {
        old: '',
        new: 'Aerial Cirque Over Denver offers week-long summer circus arts camps for kids ages 6–15. Campers learn trapeze, silks, lyra, tumbling, and juggling from professional circus instructors in a fully-equipped aerial facility.',
        confidence: 0.96,
        excerpt: 'Week-long circus arts camps for ages 6–15 in trapeze, silks, lyra, tumbling, and juggling.',
        sourceUrl: 'https://aerialcirqueoverdenver.com/aerial-camps/',
        mode: 'populate',
      },
      contactPhone: {
        old: null,
        new: '303-936-6075',
        confidence: 0.94,
        excerpt: 'Call or text us at 303-936-6075',
        sourceUrl: 'https://aerialcirqueoverdenver.com/aerial-camps/',
        mode: 'populate',
      },
    },
  },
  {
    campSlug: 'altitude-all-sports-multisport',
    sourceUrl: 'https://altitudeallsports.com/summer-camp',
    overallConfidence: 0.92,
    feedbackTags: [],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'ACCEPT registrationStatus, keep-current ageRange (excerpt too vague)',
    proposedChanges: {
      registrationStatus: {
        old: 'UNKNOWN',
        new: 'OPEN',
        confidence: 0.97,
        excerpt: 'Registration for Summer 2026 is now open — spots filling fast!',
        sourceUrl: 'https://altitudeallsports.com/summer-camp',
        mode: 'update',
      },
      ageRange: {
        old: null,
        new: 'Ages 5–18',
        confidence: 0.62,
        excerpt: 'For all ages',
        sourceUrl: 'https://altitudeallsports.com/summer-camp',
        mode: 'populate',
      },
    },
  },
  {
    campSlug: 'apex-music-camp',
    sourceUrl: 'https://www.apexmusicacademy.com/music-camp-sign-up',
    overallConfidence: 0.93,
    feedbackTags: [],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'ACCEPT all — pricing and schedule were completely empty, solid extracts',
    proposedChanges: {
      description: {
        old: '',
        new: 'Apex Music Camp is a week-long intensive for aspiring young musicians ages 8–17. Campers choose a primary instrument track (guitar, piano, drums, or voice) and spend the week in workshops, ensemble practice, and a Friday evening showcase.',
        confidence: 0.95,
        excerpt: 'Week-long music intensive for ages 8–17. Choose guitar, piano, drums, or voice.',
        sourceUrl: 'https://www.apexmusicacademy.com/music-camp-sign-up',
        mode: 'populate',
      },
      contactEmail: {
        old: null,
        new: 'camps@apexmusicacademy.com',
        confidence: 0.91,
        excerpt: 'Email us at camps@apexmusicacademy.com to reserve your spot.',
        sourceUrl: 'https://www.apexmusicacademy.com/music-camp-sign-up',
        mode: 'populate',
      },
    },
  },
  {
    campSlug: 'art-garage',
    sourceUrl: 'https://artgaragedenver.com/courses?categories=45',
    overallConfidence: 0.71,
    feedbackTags: ['needs-authority-review', 'registration-risk'],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'AMBIGUOUS — registrationStatus change OPEN→WAITLIST, low confidence, source snippet is indirect. Genuine judgment call.',
    proposedChanges: {
      registrationStatus: {
        old: 'OPEN',
        new: 'WAITLIST',
        confidence: 0.68,
        excerpt: 'Limited spots remain — join the waitlist to be notified of openings.',
        sourceUrl: 'https://artgaragedenver.com/courses?categories=45',
        mode: 'update',
      },
      description: {
        old: '',
        new: 'Art Garage offers week-long summer art camps for kids 5–12 in painting, collage, sculpture, and mixed media. Each session has a different theme and ends with a mini gallery show for families.',
        confidence: 0.93,
        excerpt: 'Summer art camps for ages 5–12 in painting, collage, sculpture, and mixed media.',
        sourceUrl: 'https://artgaragedenver.com/courses?categories=45',
        mode: 'populate',
      },
    },
  },
  {
    campSlug: 'art-camp-with-matty-miller-studio',
    sourceUrl: 'https://www.mattymiller.com/teaching',
    overallConfidence: 0.89,
    feedbackTags: [],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'ACCEPT name cleanup + email — both clearly right',
    proposedChanges: {
      name: {
        old: 'Art Camp with Matty Miller Studio',
        new: 'Matty Miller Studio Summer Art Camp',
        confidence: 0.87,
        excerpt: 'Matty Miller Studio Summer Art Camp — open for registration',
        sourceUrl: 'https://www.mattymiller.com/teaching',
        mode: 'update',
      },
      contactEmail: {
        old: null,
        new: 'matty@mattymiller.com',
        confidence: 0.92,
        excerpt: 'Questions? Email matty@mattymiller.com',
        sourceUrl: 'https://www.mattymiller.com/teaching',
        mode: 'populate',
      },
    },
  },
  {
    campSlug: 'avid-4-adventure',
    sourceUrl: 'https://avid4.com/mt-evans-camps',
    overallConfidence: 0.84,
    feedbackTags: ['needs-domain-review'],
    extractionModel: 'claude-sonnet-4-5',
    drivingNote: 'KEEP CURRENT description — current is fine, proposed is nearly identical but wordier with no real new info. One more ambiguous for variety.',
    proposedChanges: {
      description: {
        old: 'AVID 4 Adventure runs outdoor adventure camps on Mt. Evans and throughout the Colorado Rockies, helping kids build confidence through hiking, climbing, kayaking, and mountain biking.',
        new: 'AVID 4 Adventure provides outdoor adventure camps in the Colorado Rockies including Mt. Evans, focusing on hiking, rock climbing, kayaking, and mountain biking to help children develop confidence and resilience in the natural world.',
        confidence: 0.79,
        excerpt: 'Outdoor adventure camps in the Colorado Rockies — hiking, climbing, kayaking, mountain biking.',
        sourceUrl: 'https://avid4.com/mt-evans-camps',
        mode: 'update',
      },
      interestingDetails: {
        old: null,
        new: 'Trips to Rocky Mountain National Park, Eleven Mile Reservoir, and local crags. All gear provided.',
        confidence: 0.88,
        excerpt: 'Gear provided; trips to RMNP, Eleven Mile Reservoir, and local crags.',
        sourceUrl: 'https://avid4.com/mt-evans-camps',
        mode: 'populate',
      },
    },
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Seeding logic
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Seeding driving-session-1 proposals...\n');
  const pool = getPool();

  // Find a crawl run to attach to, or create a dummy one
  const crawlRunResult = await pool.query<{ id: string }>(
    `SELECT id FROM "CrawlRun" ORDER BY "startedAt" DESC LIMIT 1`,
  );
  let crawlRunId: string;
  if (crawlRunResult.rows[0]) {
    crawlRunId = crawlRunResult.rows[0].id;
    console.log(`Using existing crawl run: ${crawlRunId}`);
  } else {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO "CrawlRun" (status, trigger, "triggeredBy", "totalCamps")
       VALUES ('COMPLETED', 'MANUAL', 'driving-session-seed', 6)
       RETURNING id`,
    );
    crawlRunId = inserted.rows[0].id;
    console.log(`Created crawl run: ${crawlRunId}`);
  }

  let seeded = 0;
  let skipped = 0;

  for (const def of PROPOSALS) {
    // Resolve campId
    const campResult = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM "Camp" WHERE slug = $1 AND "archivedAt" IS NULL`,
      [def.campSlug],
    );
    if (!campResult.rows[0]) {
      console.warn(`  SKIP: camp slug '${def.campSlug}' not found`);
      skipped++;
      continue;
    }
    const { id: campId, name: campName } = campResult.rows[0];

    // Check for existing ds1 proposal (tagged driving-session-1)
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM "CampChangeProposal"
       WHERE "campId" = $1 AND status = 'PENDING'
         AND 'driving-session-1' = ANY("feedbackTags")`,
      [campId],
    );
    if (existing.rows[0]) {
      console.log(`  SKIP (exists): ${campName} → ${existing.rows[0].id}`);
      skipped++;
      continue;
    }

    // Supersede older PENDING proposals for this camp (same as real crawl flow)
    await pool.query(
      `UPDATE "CampChangeProposal"
       SET status = 'SKIPPED',
           "reviewerNotes" = COALESCE("reviewerNotes", '') || ' [Superseded by driving-session seed]',
           "reviewedAt" = now()
       WHERE "campId" = $1 AND status = 'PENDING'`,
      [campId],
    );

    const tagsWithDs1 = Array.from(new Set(['driving-session-1', ...def.feedbackTags]));

    const result = await pool.query<{ id: string }>(
      `INSERT INTO "CampChangeProposal"
         ("campId", "crawlRunId", "sourceUrl", "rawExtraction", "proposedChanges",
          "overallConfidence", "extractionModel", "feedbackTags")
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        campId,
        crawlRunId,
        def.sourceUrl,
        JSON.stringify({ model: def.extractionModel, source: 'driving-session-seed', drivingNote: def.drivingNote }),
        JSON.stringify(def.proposedChanges),
        def.overallConfidence,
        def.extractionModel,
        tagsWithDs1,
      ],
    );

    const proposalId = result.rows[0].id;
    console.log(`  SEEDED: ${campName} → ${proposalId} [${def.drivingNote}]`);
    seeded++;
  }

  console.log(`\nDone: ${seeded} seeded, ${skipped} skipped.`);
  if (seeded > 0) {
    const list = await pool.query(`
      SELECT p.id, c.name AS "campName", p."overallConfidence", p."feedbackTags"
      FROM "CampChangeProposal" p
      JOIN "Camp" c ON c.id = p."campId"
      WHERE p.status = 'PENDING' AND 'driving-session-1' = ANY(p."feedbackTags")
      ORDER BY c.name
    `);
    console.log(`\nDriving-session proposals in queue:`);
    list.rows.forEach((r: { id: string; campName: string; overallConfidence: number; feedbackTags: string[] }) => {
      console.log(`  ${r.campName} (${r.id}) conf=${r.overallConfidence} tags=${r.feedbackTags?.join(',')}`);
    });
  }
  process.exit(0);
}

main().catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
