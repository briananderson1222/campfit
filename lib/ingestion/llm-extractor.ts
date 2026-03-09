import { stripHtmlToText } from './html-stripper';
import { LLMExtractionResult } from '@/lib/admin/types';
import { callLLM, buildPrompt } from './llm-provider';
import type { CampInput } from './adapter';

const EXTRACTION_SYSTEM_PROMPT = `You are a data extraction assistant for a kids camp directory. Extract structured camp information from website text.

Return ONLY a valid JSON object with this exact shape — no markdown, no code fences, no explanation:

{
  "name": string | null,
  "description": string | null,
  "campType": "SUMMER_DAY"|"SLEEPAWAY"|"FAMILY"|"VIRTUAL"|"WINTER_BREAK"|"SCHOOL_BREAK" | null,
  "category": "SPORTS"|"ARTS"|"STEM"|"NATURE"|"ACADEMIC"|"MUSIC"|"THEATER"|"COOKING"|"MULTI_ACTIVITY"|"OTHER" | null,
  "registrationStatus": "OPEN"|"CLOSED"|"WAITLIST"|"COMING_SOON"|"UNKNOWN" | null,
  "registrationOpenDate": "YYYY-MM-DD" | null,
  "lunchIncluded": true | false | null,
  "address": string | null,
  "neighborhood": string | null,
  "city": string | null,
  "websiteUrl": string | null,
  "interestingDetails": string | null,
  "ageGroups": [{"label": string, "minAge": number|null, "maxAge": number|null, "minGrade": number|null, "maxGrade": number|null}] | null,
  "schedules": [{"label": string, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "startTime": string|null, "endTime": string|null, "earlyDropOff": string|null, "latePickup": string|null}] | null,
  "pricing": [{"label": string, "amount": number, "unit": "PER_WEEK"|"PER_SESSION"|"PER_DAY"|"FLAT"|"PER_CAMP", "durationWeeks": number|null, "ageQualifier": string|null, "discountNotes": string|null}] | null,
  "confidence": {
    "name": 0.0,
    "description": 0.0,
    "campType": 0.0,
    "category": 0.0,
    "registrationStatus": 0.0,
    "registrationOpenDate": 0.0,
    "lunchIncluded": 0.0,
    "address": 0.0,
    "neighborhood": 0.0,
    "ageGroups": 0.0,
    "schedules": 0.0,
    "pricing": 0.0,
    "interestingDetails": 0.0
  }
}

Rules:
- Set any field to null if you cannot find the information. NEVER guess or hallucinate.
- confidence values: 1.0 = explicitly stated on page, 0.5 = reasonably inferred, 0.0 = not found.
- Dates must be YYYY-MM-DD. Assume year 2026 unless stated otherwise.
- Prices are numeric USD (no $ sign).
- description should be the camp's own description of itself, 2-4 sentences max.
- interestingDetails: one memorable distinguishing fact about this camp (1 sentence).`;

export async function extractCampDataFromUrl(
  websiteUrl: string,
  campName: string,
  options: { model?: string; maxChars?: number } = {}
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
      extracted: {},
      confidence: {},
      overallConfidence: 0,
      rawResponse: '',
      model,
      tokensUsed: 0,
      extractedAt,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 2: Strip to text
  const text = stripHtmlToText(html, maxChars);
  if (text.length < 100) {
    return {
      extracted: {},
      confidence: {},
      overallConfidence: 0,
      rawResponse: '',
      model,
      tokensUsed: 0,
      extractedAt,
      error: 'Page text too short after stripping — likely JS-rendered or bot-blocked',
    };
  }

  // Step 3: Call LLM (provider auto-selected from env)
  let rawResponse = '';
  let tokensUsed = 0;

  try {
    const prompt = buildPrompt(campName, websiteUrl, text);
    const result = await callLLM(prompt);
    rawResponse = result.text;
    model = result.model;
    tokensUsed = 0; // not all providers expose token counts
  } catch (err) {
    return {
      extracted: {},
      confidence: {},
      overallConfidence: 0,
      rawResponse: '',
      model,
      tokensUsed: 0,
      extractedAt,
      error: `LLM error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 4: Parse response
  try {
    const parsed = parseExtractionResponse(rawResponse);
    return {
      extracted: parsed.extracted,
      confidence: parsed.confidence,
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
} {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const data = JSON.parse(cleaned);

  const { confidence = {}, ...rest } = data;

  // Map to CampInput shape (remove null values, keep structure)
  const extracted: Partial<CampInput> = {};
  const fields = ['name', 'description', 'campType', 'category', 'registrationStatus',
    'registrationOpenDate', 'lunchIncluded', 'address', 'neighborhood', 'city',
    'websiteUrl', 'interestingDetails', 'ageGroups', 'schedules', 'pricing'] as const;

  for (const field of fields) {
    if (rest[field] !== null && rest[field] !== undefined) {
      (extracted as Record<string, unknown>)[field] = rest[field];
    }
  }

  return { extracted, confidence };
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
