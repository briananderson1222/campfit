/**
 * LLM provider abstraction — the raw provider-calling primitives
 * (`callLLM`/`callAnthropic`/`callGemini`/`callOllama`), kept for
 * `lib/ingestion/llm-discovery.ts`'s listing-page discovery feature, which
 * has no `@kontourai/traverse` equivalent (traverse-recrawl-cutover plan,
 * AC11 — discovery stays on this legacy path deliberately).
 *
 * The hand-rolled camp-extraction prompt-builder this module used to export,
 * and its baked-in static neighborhood list, were DELETED here
 * (traverse-recrawl-cutover plan, Task 3.1 / AC3, see the migration doc for
 * the removed identifiers' names and pre-deletion wording) — camp extraction
 * is now traverse-schema-directed
 * (`lib/ingestion/traverse-schema.ts`'s `CAMP_TARGET_SCHEMA`/`CAMP_FIELD_HINTS`),
 * consumed via `lib/ingestion/traverse-recrawl-adapter.ts`. The retired
 * prompt-builder's neighborhood enum-constraint wording was captured and
 * restored as a per-call field hint there — see
 * `traverse-recrawl-adapter.ts`'s `neighborhoodFieldHint`.
 *
 * Priority (first env var found wins) for discovery's `callLLM` auto-select:
 *   GEMINI_API_KEY     → Gemini Flash (free tier, good quality)
 *   ANTHROPIC_API_KEY  → Claude Haiku (best quality)
 *   OLLAMA_MODEL       → local Ollama (free, slower)
 *   default            → Ollama with llama3.2:3b
 */

export interface LLMResponse {
  text: string;
  model: string;
  provider: string;
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

  // Auto-select: try each configured provider in order, skip on quota/auth errors
  const errors: string[] = [];

  if (process.env.GEMINI_API_KEY) {
    try { return await callGemini(prompt, process.env.GEMINI_API_KEY); }
    catch (e) { errors.push(`gemini: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await callAnthropic(prompt, process.env.ANTHROPIC_API_KEY); }
    catch (e) { errors.push(`anthropic: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  }
  // Fall back to local Ollama
  const model = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  try { return await callOllama(prompt, model); }
  catch (e) { errors.push(`ollama: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }

  throw new Error(`All LLM providers failed:\n${errors.join('\n')}`);
}
