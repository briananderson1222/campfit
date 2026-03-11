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

// Denver neighborhoods used to guide the LLM — loaded once at module level from DB if available,
// otherwise falls back to this static list so the prompt stays useful without a DB call.
const DENVER_NEIGHBORHOODS = [
  'Auraria','Baker','Barnum','Bear Valley','Capitol Hill','CBD / LoDo','Central Park',
  'Cherry Creek','Cheesman Park','City Park','City Park West','Clayton','Cole',
  'Congress Park','Curtis Park','East Colfax','Elyria Swansea','Five Points','Globeville',
  'Golden Triangle','Hale','Hampden','Hampden South','Harvey Park','Highland','Indian Creek',
  'Jefferson Park','Lincoln Park','Mayfair','Montbello','Montclair','North Capitol Hill',
  'Overland','Park Hill','Platt Park','RiNo','Ruby Hill','Sloan Lake','South Park Hill',
  'Stapleton','Sunnyside','University','University Hills','Uptown','Virginia Village',
  'Washington Park','Wellshire','West Highland','Westwood','Whittier','Windsor',
];

export function buildPrompt(campName: string, url: string, text: string, siteHints: string[] = [], neighborhoods: string[] = DENVER_NEIGHBORHOODS): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const hintsSection = siteHints.length > 0
    ? `\nSITE-SPECIFIC NOTES (apply these when extracting from this domain):\n${siteHints.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n`
    : '';
  const nbhdList = neighborhoods.length > 0 ? neighborhoods.join(', ') : '';
  const nbhdRule = nbhdList
    ? `- neighborhood must be one of these known Denver neighborhoods or null if not found: ${nbhdList}`
    : '- neighborhood: the specific area/district name if mentioned, or null';

  return `You are extracting structured data about a kids' summer camp from their website for a camp directory.

Camp name: ${campName}
Source URL: ${url}
Today's date: ${today}
${hintsSection}
RULES:
- Only extract fields you find EXPLICIT evidence for on the page. Never guess or infer beyond what is written.
- confidence: 1.0 = exact text found, 0.7 = strongly implied, 0.5 = reasonably inferred, 0 = not found. Set to 0 and null the value if you are not confident.
- excerpt: copy the EXACT verbatim sentence or phrase from the website text that proves your answer. This is REQUIRED for every non-null field — reviewers use it to verify accuracy. If you cannot find a direct quote, set the field to null with confidence 0.
- city must be a real city name (e.g. "Arvada", "Denver") — NOT a state name.
- address must be a street address only (e.g. "4001 E Iliff Ave") — NOT a neighborhood or park name.
${nbhdRule}
- campTypes must be an array containing one or more of: SUMMER_DAY, SLEEPAWAY, FAMILY, VIRTUAL, WINTER_BREAK, SCHOOL_BREAK — list all that apply (SUMMER_DAY = drop-off day camp during summer, SLEEPAWAY = overnight/residential, FAMILY = parents attend with kids, VIRTUAL = fully online, WINTER_BREAK = runs during winter/holiday school break, SCHOOL_BREAK = spring break, fall break, or other non-summer school holiday)
- categories must be an array containing one or more of: SPORTS, ARTS, STEM, NATURE, ACADEMIC, MUSIC, THEATER, COOKING, MULTI_ACTIVITY, OTHER — list all that apply
- state must be a 2-letter US state abbreviation (e.g. 'CO') if found on the page, or null
- zip must be a 5-digit US zip code if found on the page, or null
- registrationStatus must be one of: OPEN, FULL, WAITLIST, CLOSED, COMING_SOON, UNKNOWN
  Use today's date (${today}) to reason about which status is correct:
  COMING_SOON = registration opens in the FUTURE (open date is after today)
  OPEN = registration is currently open (open date is in the past OR page says "register now" / "enroll today")
  FULL = at capacity, no spots left
  WAITLIST = full but waitlist is available
  CLOSED = registration period has ended
  UNKNOWN = no clear registration information found
  IMPORTANT: If the page mentions a registration open date that has already passed (before ${today}), do NOT use COMING_SOON — use OPEN or UNKNOWN depending on whether the page confirms registration is still active.

- registrationOpenDate: the date registration opens, as YYYY-MM-DD. Only set if an explicit future or past date is stated on the page.
- registrationCloseDate: the date registration closes or the deadline to register, as YYYY-MM-DD. Only set if explicitly stated.

Return ONLY valid JSON matching this exact shape — no markdown fences, no explanation:

{
  "extracted": {
    "description": string | null,
    "city": string | null,
    "neighborhood": string | null,
    "address": string | null,
    "lunchIncluded": boolean | null,
    "registrationStatus": "OPEN"|"FULL"|"WAITLIST"|"CLOSED"|"COMING_SOON"|"UNKNOWN"|null,
    "registrationOpenDate": "YYYY-MM-DD" | null,
    "registrationCloseDate": "YYYY-MM-DD" | null,
    "campTypes": ["SUMMER_DAY"|"SLEEPAWAY"|"FAMILY"|"VIRTUAL"|"WINTER_BREAK"|"SCHOOL_BREAK"],
    "categories": ["SPORTS"|"ARTS"|"STEM"|"NATURE"|"ACADEMIC"|"MUSIC"|"THEATER"|"COOKING"|"MULTI_ACTIVITY"|"OTHER"],
    "state": "CO" | null,
    "zip": "80000" | null
  },
  "confidence": {
    "description": 0,
    "city": 0,
    "neighborhood": 0,
    "address": 0,
    "lunchIncluded": 0,
    "registrationStatus": 0,
    "registrationOpenDate": 0,
    "registrationCloseDate": 0,
    "campTypes": 0,
    "categories": 0,
    "state": 0,
    "zip": 0
  },
  "excerpts": {
    "description": "verbatim quote from page or null",
    "city": "verbatim quote from page or null",
    "neighborhood": "verbatim quote from page or null",
    "address": "verbatim quote from page or null",
    "lunchIncluded": "verbatim quote from page or null",
    "registrationStatus": "verbatim quote from page or null",
    "registrationOpenDate": "verbatim quote from page or null",
    "registrationCloseDate": "verbatim quote from page or null",
    "campTypes": "verbatim quote from page or null",
    "categories": "verbatim quote from page or null",
    "state": "verbatim quote from page or null",
    "zip": "verbatim quote from page or null"
  }
}

Website text:
${text.slice(0, 20000)}`;
}

async function callAnthropic(prompt: string, apiKey: string, modelId?: string): Promise<LLMResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const model = modelId ?? 'claude-haiku-4-5-20251001';
  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
  return { text, model, provider: 'anthropic' };
}

async function callGemini(prompt: string, apiKey: string, modelId?: string): Promise<LLMResponse> {
  const model = modelId ?? 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
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

/**
 * Call an LLM with an optional model override.
 *
 * @param prompt - The prompt to send.
 * @param modelOverride - Optional "provider:model" string, e.g. "gemini:gemini-2.0-flash".
 *   When provided, the specified provider and model are used directly.
 *   When omitted, falls back to the auto-select priority (anthropic → gemini → ollama).
 */
export async function callLLM(prompt: string, modelOverride?: string): Promise<LLMResponse> {
  if (modelOverride) {
    const colonIdx = modelOverride.indexOf(':');
    if (colonIdx === -1) throw new Error(`Invalid modelOverride format: "${modelOverride}". Expected "provider:model".`);
    const provider = modelOverride.slice(0, colonIdx);
    const modelId = modelOverride.slice(colonIdx + 1);

    if (provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      return callAnthropic(prompt, apiKey, modelId);
    }
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
      return callGemini(prompt, apiKey, modelId);
    }
    if (provider === 'ollama') {
      return callOllama(prompt, modelId);
    }
    throw new Error(`Unknown provider: "${provider}"`);
  }

  // Auto-select: first available provider wins
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
