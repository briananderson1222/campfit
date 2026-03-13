import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export interface LLMModel {
  id: string;
  label: string;
  provider: 'anthropic' | 'gemini' | 'ollama';
  badge: string;
}

export interface ModelsResponse {
  models: LLMModel[];
  default: string;
}

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const models: LLMModel[] = [];

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;

  models.push(
    { id: 'anthropic:claude-haiku-4-5-20251001', label: 'Claude Haiku', provider: 'anthropic', badge: hasAnthropic ? 'Fastest' : 'No Key' },
    { id: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet', provider: 'anthropic', badge: hasAnthropic ? 'Best' : 'No Key' },
    { id: 'gemini:gemini-2.0-flash', label: 'Gemini Flash', provider: 'gemini', badge: hasGemini ? 'Free' : 'No Key' },
    { id: 'gemini:gemini-1.5-pro', label: 'Gemini Pro', provider: 'gemini', badge: hasGemini ? 'Slow' : 'No Key' },
  );

  // Ollama models — only usable when running locally (dev server / CLI crawl)
  const isLocal = process.env.NODE_ENV === 'development' || !!process.env.OLLAMA_MODEL;
  const ollamaDefault = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  const ollamaBadge = isLocal ? 'Local' : 'Local Only';
  const ollamaModels: LLMModel[] = [
    { id: `ollama:${ollamaDefault}`, label: ollamaDefault, provider: 'ollama', badge: ollamaBadge },
  ];
  if (ollamaDefault !== 'llama3.2:3b') ollamaModels.push({ id: 'ollama:llama3.2:3b', label: 'Llama 3.2 3B', provider: 'ollama', badge: ollamaBadge });
  if (ollamaDefault !== 'gemma3:1b') ollamaModels.push({ id: 'ollama:gemma3:1b', label: 'Gemma 3 1B', provider: 'ollama', badge: ollamaBadge });
  models.push(...ollamaModels);

  // Default: first model with a real key, otherwise first Ollama model
  const firstWithKey = models.find(m => m.badge !== 'No Key');
  const defaultModel = firstWithKey?.id ?? ollamaModels[0].id;

  return NextResponse.json({ models, default: defaultModel } satisfies ModelsResponse);
}
