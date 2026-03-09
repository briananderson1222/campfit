/**
 * LLM provider abstraction for camp data extraction.
 *
 * Priority (first env var found wins):
 *   ANTHROPIC_API_KEY  → Claude Haiku (best quality)
 *   GEMINI_API_KEY     → Gemini Flash (free tier, good quality)
 *   OLLAMA_MODEL       → local Ollama (free, slower)
 *   default            → Ollama with llama3.2:3b
 */

export interface LLMResponse {
  text: string;
  model: string;
  provider: string;
}

const EXTRACTION_SCHEMA = `{
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
    "description": number 0-1,
    "city": number 0-1,
    "neighborhood": number 0-1,
    "address": number 0-1,
    "lunchIncluded": number 0-1,
    "registrationStatus": number 0-1,
    "campType": number 0-1,
    "category": number 0-1
  }
}`;

export function buildPrompt(campName: string, url: string, text: string): string {
  return `You are extracting structured data about a kids' camp from their website.
Camp name: ${campName}
Source URL: ${url}

Extract what you can find. For each field:
- Set confidence 0-1 (1.0 = explicitly stated, 0.5 = inferred, 0 = not found)
- Set excerpt to the verbatim sentence/phrase from the page that supports the value (null if not found)
Only include fields with evidence. Return ONLY valid JSON — no markdown, no explanation.

Schema:
${EXTRACTION_SCHEMA}

Also include:
  "excerpts": { <same field names as extracted, value is the supporting quote from the page or null> }

Website text:
${text.slice(0, 20000)}`;
}

async function callAnthropic(prompt: string, apiKey: string): Promise<LLMResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = 'claude-haiku-4-5-20251001';
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return { text, model, provider: 'anthropic' };
}

async function callGemini(prompt: string, apiKey: string): Promise<LLMResponse> {
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return { text, model, provider: 'gemini' };
}

async function callOllama(prompt: string, model: string): Promise<LLMResponse> {
  const baseUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
    signal: AbortSignal.timeout(180_000), // 3 min max
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const data = await res.json() as { response: string };
  return { text: data.response, model, provider: 'ollama' };
}

export async function callLLM(prompt: string): Promise<LLMResponse> {
  if (process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(prompt, process.env.ANTHROPIC_API_KEY);
  }
  if (process.env.GEMINI_API_KEY) {
    return callGemini(prompt, process.env.GEMINI_API_KEY);
  }
  // Fall back to local Ollama
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  return callOllama(prompt, model);
}
