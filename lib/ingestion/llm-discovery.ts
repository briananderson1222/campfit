/**
 * Camp discovery — detects listing pages and extracts a list of individual camp programs.
 *
 * Used as a pre-pass in the crawl pipeline when 2+ existing camps share the same websiteUrl,
 * signaling that the URL is a listing page (e.g. "All Summer Programs" index).
 *
 * The LLM returns a structured list of camp stubs. Each stub is then:
 *  1. Fuzzy-deduplicated against existing camp names (Dice coefficient, threshold 0.75)
 *  2. Inserted as a new Camp record with dataConfidence='PLACEHOLDER'
 *  3. Fed back into the normal update loop so a fresh extraction immediately runs
 */

import { callLLM } from './llm-provider';
import { stripHtmlToText } from './html-stripper';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredCampStub {
  name: string;
  /** URL pointing directly to this program's detail page, if found */
  detailUrl: string | null;
  /** One-liner description from the listing if available */
  snippet: string | null;
}

export interface DiscoveryResult {
  /** Whether the LLM judged this page to be a multi-program listing */
  isListingPage: boolean;
  stubs: DiscoveredCampStub[];
  /** Model that was used */
  model: string;
  error?: string;
}

// ── Bigram similarity (Dice coefficient) ─────────────────────────────────────

function bigrams(str: string): Set<string> {
  const s = str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
  return result;
}

function diceCoefficient(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  ba.forEach(gram => { if (bb.has(gram)) intersection++; });
  return (2 * intersection) / (ba.size + bb.size);
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Fetch a URL and ask the LLM to list all distinct camp programs found on the page.
 */
export async function discoverCampsFromUrl(
  url: string,
  options: { model?: string; maxChars?: number } = {}
): Promise<DiscoveryResult> {
  const maxChars = options.maxChars ?? 32_000;
  let model = options.model ?? 'auto';

  // Fetch HTML
  let html: string;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    return { isListingPage: false, stubs: [], model, error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = stripHtmlToText(html, maxChars);
  if (text.length < 100) {
    return { isListingPage: false, stubs: [], model, error: 'Page text too short — likely JS-rendered or bot-blocked' };
  }

  const prompt = buildDiscoveryPrompt(url, text);

  let raw = '';
  try {
    const result = await callLLM(prompt, options.model !== 'auto' ? options.model : undefined);
    raw = result.text;
    model = result.model;
  } catch (err) {
    return { isListingPage: false, stubs: [], model, error: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
  }

  return parseDiscoveryResponse(raw, model);
}

/**
 * Given the stubs returned by the LLM, filter out any that closely match existing camp names.
 * Returns only genuinely new programs.
 */
export function filterNewDiscoveries(
  stubs: DiscoveredCampStub[],
  existingNames: string[],
  threshold = 0.75
): DiscoveredCampStub[] {
  return stubs.filter(stub => {
    for (const existing of existingNames) {
      if (diceCoefficient(stub.name, existing) >= threshold) return false;
    }
    return true;
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildDiscoveryPrompt(url: string, text: string): string {
  return `You are analyzing a kids' camp website page to discover all distinct camp programs listed.

Source URL: ${url}

TASK:
1. Determine if this page lists multiple distinct camp programs/sessions (a "listing page").
   A listing page typically shows 3+ different named programs with brief descriptions.
   A single-camp detail page is NOT a listing page.

2. If it is a listing page, extract every distinct camp program name you find.
   - Include the direct URL to each program's detail page if one is linked (make it absolute using the source URL as base).
   - Include a short snippet/description (1-2 sentences) from the listing if available.
   - Each program should be a genuinely distinct camp offering (different name, age range, theme, etc.).
   - Do NOT include schedule sessions/weeks of the same program as separate entries.

Return ONLY valid JSON matching this exact shape — no markdown fences, no explanation:

{
  "isListingPage": true | false,
  "camps": [
    {
      "name": "Program Name",
      "detailUrl": "https://... or null",
      "snippet": "Brief description or null"
    }
  ]
}

If isListingPage is false, return an empty camps array.

Website text:
${text.slice(0, 24_000)}`;
}

function parseDiscoveryResponse(raw: string, model: string): DiscoveryResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { isListingPage: false, stubs: [], model, error: `No JSON in LLM response: ${raw.slice(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      isListingPage?: boolean;
      camps?: Array<{ name?: string; detailUrl?: string | null; snippet?: string | null }>;
    };
    const isListingPage = parsed.isListingPage === true;
    const stubs: DiscoveredCampStub[] = (parsed.camps ?? [])
      .filter(c => typeof c.name === 'string' && c.name.trim().length > 0)
      .map(c => ({
        name: c.name!.trim(),
        detailUrl: c.detailUrl?.trim() || null,
        snippet: c.snippet?.trim() || null,
      }));
    return { isListingPage, stubs, model };
  } catch (err) {
    return { isListingPage: false, stubs: [], model, error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
