#!/usr/bin/env node
/**
 * Local crawl runner — bypasses Vercel serverless timeout limits.
 *
 * Usage:
 *   node scripts/run-crawl.mjs               # all camps
 *   node scripts/run-crawl.mjs --limit 5     # first 5 camps (by lastVerifiedAt)
 *   node scripts/run-crawl.mjs --id abc,def  # specific camp IDs
 *   node scripts/run-crawl.mjs --dry-run     # fetch URLs, skip LLM + DB writes
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';
import * as cheerio from 'cheerio';

const { Pool } = pg;

// ── Config ─────────────────────────────────────────────────────────────────

// Load .env manually (no dotenv dep needed)
function loadEnv(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) {
        // strip quotes and literal \n escape sequences
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\\n/g, '').trim();
      }
    }
  } catch {}
}
loadEnv('.env.prod');
loadEnv('.env.local');
loadEnv('.env');

const PGHOST     = 'aws-0-us-west-2.pooler.supabase.com';
const PGPORT     = 6543;
const PGDATABASE = 'postgres';
const PGUSER     = 'postgres.rpnzolnnhbzhuspwpajq';
const PGPASSWORD = process.env.PGPASSWORD || 'eDG*8dX-c#eD2Z2';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

const pool = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD, ssl: { rejectUnauthorized: false }, max: 3 });

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit   = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : null;
const idIdx   = args.indexOf('--id');
const campIds = idIdx !== -1 ? args[idIdx + 1].split(',') : null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPage(url) {
  log(`  → GET ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    log(`  → HTTP ${res.status} (${res.headers.get('content-type')?.split(';')[0]})`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(html, url) {
  const $ = cheerio.load(html);

  // Log page title so we can see what loaded
  const title = $('title').text().trim();
  if (title) log(`  → page title: "${title}"`);

  // Collect interesting internal links for visibility
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().slice(0, 60);
    if (href.startsWith('/') || href.includes(new URL(url).hostname)) {
      const kw = /camp|register|enroll|schedule|price|cost|summer|program/i.test(href + text);
      if (kw && links.length < 6) links.push(`${text || href}`);
    }
  });
  if (links.length) log(`  → interesting links: ${links.join(' | ')}`);

  $('script, style, nav, footer, header, iframe, noscript, [aria-hidden="true"]').remove();
  const main = $('main, article, [role="main"], .content, #content, #main').first();
  const text = (main.length ? main : $('body')).text();
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 24000);
  log(`  → extracted ${cleaned.length} chars of text content`);
  return cleaned;
}

function buildPrompt(campName, url, text, siteHints = [], neighborhoods = []) {
  const hintsSection = siteHints.length > 0
    ? `\nSITE-SPECIFIC NOTES (apply these when extracting from this domain):\n${siteHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n`
    : '';
  const nbhdRule = neighborhoods.length > 0
    ? `- neighborhood must be one of these known neighborhoods or null if not found: ${neighborhoods.join(', ')}`
    : '- neighborhood: the specific area/district name if mentioned, or null';

  return `You are extracting structured data about a kids' summer camp from their website for a camp directory.

Camp name: ${campName}
Source URL: ${url}
${hintsSection}
RULES:
- Only extract fields you find EXPLICIT evidence for on the page. Never guess or infer beyond what is written.
- confidence: 1.0 = exact text found, 0.7 = strongly implied, 0.5 = reasonably inferred, 0 = not found. Set to 0 and null the value if you are not confident.
- excerpt: copy the EXACT verbatim sentence or phrase from the website text that proves your answer. This is REQUIRED for every non-null field — reviewers use it to verify accuracy. If you cannot find a direct quote, set the field to null with confidence 0.
- city must be a real city name (e.g. "Arvada", "Denver") — NOT a state name.
- address must be a street address only (e.g. "4001 E Iliff Ave") — NOT a neighborhood or park name.
${nbhdRule}
- campType must be one of: SUMMER_DAY, SLEEPAWAY, FAMILY, VIRTUAL, WINTER_BREAK, SCHOOL_BREAK
- category must be one of: SPORTS, ARTS, STEM, NATURE, ACADEMIC, MUSIC, THEATER, COOKING, MULTI_ACTIVITY, OTHER
- registrationStatus must be one of: OPEN, FULL, WAITLIST, CLOSED, COMING_SOON, UNKNOWN
  OPEN=accepting registrations, FULL=at capacity (no spots left), WAITLIST=full but waitlist available, CLOSED=registration period ended

Return ONLY valid JSON matching this exact shape — no markdown fences, no explanation:

{
  "extracted": {
    "description": string | null,
    "city": string | null,
    "neighborhood": string | null,
    "address": string | null,
    "lunchIncluded": boolean | null,
    "registrationStatus": "OPEN"|"FULL"|"WAITLIST"|"CLOSED"|"COMING_SOON"|"UNKNOWN"|null,
    "campType": "SUMMER_DAY"|"SLEEPAWAY"|"FAMILY"|"VIRTUAL"|"WINTER_BREAK"|"SCHOOL_BREAK"|null,
    "category": "SPORTS"|"ARTS"|"STEM"|"NATURE"|"ACADEMIC"|"MUSIC"|"THEATER"|"COOKING"|"MULTI_ACTIVITY"|"OTHER"|null
  },
  "confidence": {
    "description": 0,
    "city": 0,
    "neighborhood": 0,
    "address": 0,
    "lunchIncluded": 0,
    "registrationStatus": 0,
    "campType": 0,
    "category": 0
  },
  "excerpts": {
    "description": "verbatim quote from page or null",
    "city": "verbatim quote from page or null",
    "neighborhood": "verbatim quote from page or null",
    "address": "verbatim quote from page or null",
    "lunchIncluded": "verbatim quote from page or null",
    "registrationStatus": "verbatim quote from page or null",
    "campType": "verbatim quote from page or null",
    "category": "verbatim quote from page or null"
  }
}

Website text:
${text.slice(0, 20000)}`;
}

/** Extract bare hostname without www prefix for hint lookups */
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/** Fetch active site hints for a domain */
async function getSiteHints(domain) {
  if (!domain) return [];
  const { rows } = await pool.query(
    `SELECT hint FROM "CrawlSiteHint" WHERE domain = $1 AND active = true ORDER BY "createdAt" ASC`,
    [domain]
  );
  return rows.map(r => r.hint);
}

/** Fetch known neighborhoods for a community */
async function getNeighborhoods(communitySlug = 'denver') {
  const { rows } = await pool.query(
    `SELECT name FROM "CommunityNeighborhood" WHERE "communitySlug" = $1 ORDER BY name ASC`,
    [communitySlug]
  );
  return rows.map(r => r.name);
}

async function callLLM(prompt) {
  if (ANTHROPIC_API_KEY) {
    log(`  → calling Anthropic claude-haiku-4-5…`);
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    log(`  → LLM response received (${msg.usage?.output_tokens ?? '?'} tokens)`);
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  }
  if (GEMINI_API_KEY) {
    // gemini-1.5-flash removed (404 on v1beta); gemini-2.0-flash-exp is free tier
    const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-exp'];
    for (const model of models) {
      log(`  → calling Gemini ${model}…`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
          }),
        });
        if (res.status === 429) {
          const err = await res.json().catch(() => ({}));
          const retryAfter = err?.error?.details?.find(d => d.retryDelay)?.retryDelay;
          const retryMs = retryAfter ? (parseInt(retryAfter) * 1000) : 15000;
          log(`  → 429 rate limit on ${model}, waiting ${Math.round(retryMs/1000)}s… (attempt ${attempt+1}/5)`);
          await delay(retryMs + 1000);
          continue;
        }
        if (!res.ok) {
          const txt = await res.text();
          if (txt.includes('limit: 0') || txt.includes('RESOURCE_EXHAUSTED') || res.status === 404) {
            log(`  → ${model} unavailable (${res.status}), trying next model…`);
            break; // try next model
          }
          throw new Error(`Gemini ${res.status}: ${txt}`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        log(`  → Gemini ${model} response received`);
        return text;
      }
    }
    throw new Error('All Gemini models exhausted or quota at 0');
  }
  // Ollama
  log(`  → using Ollama model: ${OLLAMA_MODEL}`);
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json' }),
    signal: AbortSignal.timeout(180000), // 3 min max per inference
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.response ?? '';
}

async function extractWithLLM(url, campName, text, siteHints = [], neighborhoods = []) {
  const prompt = buildPrompt(campName, url, text, siteHints, neighborhoods);
  if (siteHints.length) log(`  → injecting ${siteHints.length} site hint(s) into prompt`);
  const raw = await callLLM(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

function computeDiff(current, extracted, confidence, excerpts = {}, sourceUrl = '') {
  const THRESHOLD = 0.3;
  // Fields approved within this window are suppressed at low confidence — prevents
  // re-proposing the same change if a reviewer recently verified the value.
  const SUPPRESS_DAYS = 30;
  const now = Date.now();
  const fieldSources = current.fieldSources ?? {};
  const diff = {};

  for (const [field, newVal] of Object.entries(extracted)) {
    if (newVal === null || newVal === undefined) continue;
    const conf = confidence[field] ?? 0;
    if (conf < THRESHOLD) continue;

    const oldVal = current[field];
    const oldStr = oldVal === null || oldVal === undefined ? '' : String(oldVal).trim();
    const newStr = String(newVal).trim();
    if (oldStr === newStr) continue; // no change

    // Suppress if this field was recently approved AND the new extraction has low confidence.
    // High-confidence extractions still surface even for recently-verified fields (genuine change).
    const src = fieldSources[field];
    if (src?.approvedAt) {
      const daysSince = (now - new Date(src.approvedAt).getTime()) / 86400000;
      if (daysSince < SUPPRESS_DAYS && conf < 0.8) {
        log(`  → suppressing "${field}" (approved ${Math.round(daysSince)}d ago, conf=${conf.toFixed(2)} < 0.8)`);
        continue;
      }
    }

    const excerpt = excerpts[field] && excerpts[field] !== 'null' ? excerpts[field] : null;
    diff[field] = { old: oldVal, new: newVal, confidence: conf, excerpt, sourceUrl };
  }
  return diff;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting crawl — dry=${dryRun} limit=${limit ?? 'all'} ids=${campIds?.join(',') ?? 'none'}`);

  // Load camps
  let query, params = [];
  const cols = `id, name, "websiteUrl", description, city, neighborhood, address, "lunchIncluded", "registrationStatus", "campType", category, COALESCE("fieldSources", '{}') AS "fieldSources"`;
  if (campIds) {
    query = `SELECT ${cols} FROM "Camp" WHERE id = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`;
    params = [campIds];
  } else {
    query = `SELECT ${cols} FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != '' ORDER BY "lastVerifiedAt" ASC NULLS FIRST${limit ? ` LIMIT ${limit}` : ''}`;
  }
  const { rows: camps } = await pool.query(query, params);
  log(`Found ${camps.length} camps to crawl`);

  // Load neighborhoods once for the whole run
  const neighborhoods = dryRun ? [] : await getNeighborhoods('denver');

  // Create run record
  let runId = null;
  if (!dryRun) {
    const { rows: [run] } = await pool.query(
      `INSERT INTO "CrawlRun" ("totalCamps", trigger, "triggeredBy") VALUES ($1, 'MANUAL', 'cli') RETURNING id`,
      [camps.length]
    );
    runId = run.id;
    log(`CrawlRun created: ${runId}`);
  }

  let processed = 0, errors = 0, proposals = 0;

  for (let i = 0; i < camps.length; i++) {
    const camp = camps[i];
    log(`[${i + 1}/${camps.length}] ${camp.name} — ${camp.websiteUrl}`);

    try {
      // Fetch
      const html = await fetchPage(camp.websiteUrl);
      const text = stripHtml(html, camp.websiteUrl);
      log(`  → fetched ${text.length} chars`);

      if (dryRun) {
        log(`  → [dry-run] skipping LLM`);
        processed++;
        continue;
      }

      // Fetch site hints for this domain
      const siteHints = dryRun ? [] : await getSiteHints(domainOf(camp.websiteUrl));

      // Extract
      const { extracted, confidence, excerpts = {} } = await extractWithLLM(camp.websiteUrl, camp.name, text, siteHints, neighborhoods);
      log(`  → extracted: ${JSON.stringify(Object.keys(extracted).filter(k => extracted[k] !== null))}`);
      log(`  → confidence: ${JSON.stringify(confidence)}`);
      log(`  → excerpts: ${JSON.stringify(Object.fromEntries(Object.entries(excerpts).filter(([,v]) => v && v !== 'null')))}`);

      // Diff
      const diff = computeDiff(camp, extracted, confidence, excerpts, camp.websiteUrl);
      const changesFound = Object.keys(diff).length;
      log(`  → ${changesFound} changes found: ${JSON.stringify(Object.keys(diff))}`);

      // Save proposal
      if (changesFound > 0) {
        const overallConf = Object.values(diff).reduce((s, v) => s + v.confidence, 0) / changesFound;
        await pool.query(
          `INSERT INTO "CampChangeProposal" ("campId", "crawlRunId", "sourceUrl", "rawExtraction", "proposedChanges", "overallConfidence", "extractionModel")
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [camp.id, runId, camp.websiteUrl, JSON.stringify(extracted), JSON.stringify(diff), overallConf, 'claude-haiku-4-5-20251001']
        );
        proposals++;
        log(`  → proposal created (confidence: ${overallConf.toFixed(2)})`);
      }

      processed++;
      if (runId) {
        await pool.query(`UPDATE "CrawlRun" SET "processedCamps"=$1, "newProposals"=$2 WHERE id=$3`, [processed, proposals, runId]);
      }
    } catch (err) {
      errors++;
      log(`  → ERROR: ${err.message}`);
      if (runId) {
        await pool.query(
          `UPDATE "CrawlRun" SET "errorCount"=$1, "processedCamps"=$2, "errorLog"="errorLog" || $3::jsonb WHERE id=$4`,
          [errors, processed, JSON.stringify([{ campId: camp.id, url: camp.websiteUrl, error: err.message }]), runId]
        );
      }
    }

    if (i < camps.length - 1) await delay(2000);
  }

  // Complete
  if (runId) {
    const status = errors === camps.length && camps.length > 0 ? 'FAILED' : 'COMPLETED';
    await pool.query(`UPDATE "CrawlRun" SET status=$1, "completedAt"=now(), "processedCamps"=$2, "errorCount"=$3, "newProposals"=$4 WHERE id=$5`,
      [status, processed, errors, proposals, runId]);
  }

  log(`Done — processed=${processed} errors=${errors} proposals=${proposals}`);
  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); process.exit(1); });
