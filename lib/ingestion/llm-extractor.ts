import { stripHtmlToText } from './html-stripper';
import { LLMExtractionResult } from '@/lib/admin/types';
import { callLLM, buildPrompt } from './llm-provider';
import type { CampInput } from './adapter';

export async function extractCampDataFromUrl(
  websiteUrl: string,
  campName: string,
  options: { model?: string; maxChars?: number; siteHints?: string[]; neighborhoods?: string[] } = {}
): Promise<LLMExtractionResult> {
  const maxChars = options.maxChars ?? 32_000;
  const extractedAt = new Date().toISOString();
  let model = options.model ?? 'auto';

  // Step 1: Fetch HTML
  let html: string;
  try {
    const res = await fetch(websiteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    return {
      extracted: {}, confidence: {}, excerpts: {}, overallConfidence: 0,
      rawResponse: '', model, tokensUsed: 0, extractedAt,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 2: Strip to text
  const text = stripHtmlToText(html, maxChars);
  if (text.length < 100) {
    return {
      extracted: {}, confidence: {}, excerpts: {}, overallConfidence: 0,
      rawResponse: '', model, tokensUsed: 0, extractedAt,
      error: 'Page text too short after stripping — likely JS-rendered or bot-blocked',
    };
  }

  // Step 3: Call LLM (provider auto-selected from env)
  let rawResponse = '';
  let tokensUsed = 0;

  try {
    const prompt = buildPrompt(campName, websiteUrl, text, options.siteHints, options.neighborhoods);
    const result = await callLLM(prompt, options.model !== 'auto' ? options.model : undefined);
    rawResponse = result.text;
    model = result.model;
    tokensUsed = 0; // not all providers expose token counts
  } catch (err) {
    return {
      extracted: {}, confidence: {}, excerpts: {}, overallConfidence: 0,
      rawResponse: '', model, tokensUsed: 0, extractedAt,
      error: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 4: Parse response
  try {
    const parsed = parseExtractionResponse(rawResponse);
    return {
      extracted: parsed.extracted,
      confidence: parsed.confidence,
      excerpts: parsed.excerpts,
      overallConfidence: computeOverallConfidence(parsed.confidence),
      rawResponse,
      model,
      tokensUsed,
      extractedAt,
    };
  } catch (err) {
    return {
      extracted: {},
      confidence: {},
      excerpts: {},
      overallConfidence: 0,
      rawResponse,
      model,
      tokensUsed,
      extractedAt,
      error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseExtractionResponse(raw: string): {
  extracted: Partial<CampInput>;
  confidence: Record<string, number>;
  excerpts: Record<string, string>;
} {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const data = JSON.parse(cleaned);

  const { confidence = {}, excerpts: rawExcerpts = {}, extracted: extractedRaw = {}, ...rest } = data;

  // Support both nested { extracted: {...} } and flat top-level shapes from the LLM
  const source: Record<string, unknown> = Object.keys(extractedRaw).length > 0 ? extractedRaw : rest;

  // Map to CampInput shape (remove null values, keep structure)
  const extracted: Partial<CampInput> = {};
  const fields = ['name', 'description', 'campType', 'category', 'campTypes', 'categories',
    'registrationStatus', 'registrationOpenDate', 'registrationCloseDate',
    'lunchIncluded', 'address', 'neighborhood', 'city', 'state', 'zip',
    'websiteUrl', 'interestingDetails', 'ageGroups', 'schedules', 'pricing'] as const;

  for (const field of fields) {
    if (source[field] !== null && source[field] !== undefined) {
      (extracted as Record<string, unknown>)[field] = source[field];
    }
  }

  // Normalize excerpts — only keep non-null strings
  const excerpts: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawExcerpts)) {
    if (v && typeof v === 'string') excerpts[k] = v;
  }

  return { extracted, confidence, excerpts };
}

function computeOverallConfidence(confidence: Record<string, number>): number {
  const values = Object.values(confidence).filter((v) => typeof v === 'number');
  if (values.length === 0) return 0;
  // Weight important fields higher
  const weights: Record<string, number> = {
    name: 0.5, description: 1.5, registrationStatus: 2, pricing: 2,
    schedules: 2, ageGroups: 1.5, registrationOpenDate: 1.5,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [field, conf] of Object.entries(confidence)) {
    const w = weights[field] ?? 1;
    weightedSum += conf * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : 0;
}
