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
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CampFitBot/1.0; +https://camp.fit)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function stripHtml(html, url) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, iframe, noscript, [aria-hidden="true"]').remove();
  const main = $('main, article, [role="main"], .content, #content, #main').first();
  const text = (main.length ? main : $('body')).text();
  return text.replace(/\s+/g, ' ').trim().slice(0, 24000);
}

function buildPrompt(campName, url, text) {
  return `You are extracting structured data about a kids' camp from their website.
Camp name: ${campName}
Source URL: ${url}

Extract what you can find. For each field, provide a confidence score 0-1.
Only include fields you found evidence for — set others to null with confidence 0.
Return ONLY valid JSON, no markdown fences, no explanation.

{
  "extracted": {
    "description": string | null,
    "city": string | null,
    "neighborhood": string | null,
    "address": string | null,
    "lunchIncluded": boolean | null,
    "registrationStatus": "OPEN"|"CLOSED"|"WAITLIST"|"UNKNOWN"|null,
    "campType": "SUMMER_DAY"|"SUMMER_OVERNIGHT"|"AFTER_SCHOOL"|"ENRICHMENT"|"SPORTS_CLINIC"|null,
    "category": "STEM"|"ARTS"|"SPORTS"|"NATURE"|"ACADEMIC"|"MULTI_ACTIVITY"|"FAITH"|"SPECIAL_NEEDS"|null
  },
  "confidence": {
    "description": number,
    "city": number,
    "neighborhood": number,
    "address": number,
    "lunchIncluded": number,
    "registrationStatus": number,
    "campType": number,
    "category": number
  }
}

Website text:
${text.slice(0, 20000)}`;
}

async function callLLM(prompt) {
  if (ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  }
  if (GEMINI_API_KEY) {
    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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

async function extractWithLLM(url, campName, text) {
  const prompt = buildPrompt(campName, url, text);
  const raw = await callLLM(prompt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

function computeDiff(current, extracted, confidence) {
  const THRESHOLD = 0.3;
  const diff = {};
  for (const [field, newVal] of Object.entries(extracted)) {
    if (newVal === null || newVal === undefined) continue;
    if ((confidence[field] ?? 0) < THRESHOLD) continue;
    const oldVal = current[field];
    const oldStr = oldVal === null || oldVal === undefined ? '' : String(oldVal).trim();
    const newStr = String(newVal).trim();
    if (oldStr !== newStr) {
      diff[field] = { old: oldVal, new: newVal, confidence: confidence[field] };
    }
  }
  return diff;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting crawl — dry=${dryRun} limit=${limit ?? 'all'} ids=${campIds?.join(',') ?? 'none'}`);

  // Load camps
  let query, params = [];
  if (campIds) {
    query = `SELECT id, name, "websiteUrl", description, city, neighborhood, address, "lunchIncluded", "registrationStatus", "campType", category FROM "Camp" WHERE id = ANY($1) AND "websiteUrl" IS NOT NULL AND "websiteUrl" != ''`;
    params = [campIds];
  } else {
    query = `SELECT id, name, "websiteUrl", description, city, neighborhood, address, "lunchIncluded", "registrationStatus", "campType", category FROM "Camp" WHERE "websiteUrl" IS NOT NULL AND "websiteUrl" != '' ORDER BY "lastVerifiedAt" ASC NULLS FIRST${limit ? ` LIMIT ${limit}` : ''}`;
  }
  const { rows: camps } = await pool.query(query, params);
  log(`Found ${camps.length} camps to crawl`);

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

      // Extract
      const { extracted, confidence } = await extractWithLLM(camp.websiteUrl, camp.name, text);
      log(`  → extracted: ${JSON.stringify(Object.keys(extracted).filter(k => extracted[k] !== null))}`);
      log(`  → confidence: ${JSON.stringify(confidence)}`);

      // Diff
      const diff = computeDiff(camp, extracted, confidence);
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
