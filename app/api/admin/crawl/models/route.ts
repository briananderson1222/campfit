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

  if (process.env.ANTHROPIC_API_KEY) {
    models.push(
      { id: 'anthropic:claude-haiku-4-5-20251001', label: 'Claude Haiku', provider: 'anthropic', badge: 'Fastest' },
      { id: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet', provider: 'anthropic', badge: 'Best' },
    );
  }

  if (process.env.GEMINI_API_KEY) {
    models.push(
      { id: 'gemini:gemini-2.0-flash', label: 'Gemini Flash', provider: 'gemini', badge: 'Free' },
      { id: 'gemini:gemini-1.5-pro', label: 'Gemini Pro', provider: 'gemini', badge: 'Slow' },
    );
  }

  // Ollama is always available as a fallback
  models.push(
    { id: 'ollama:llama3.2:3b', label: 'Llama 3.2 3B', provider: 'ollama', badge: 'Local' },
    { id: 'ollama:gemma3:1b', label: 'Gemma 3 1B', provider: 'ollama', badge: 'Local/Fast' },
  );

  const defaultModel = models[0]?.id ?? 'ollama:llama3.2:3b';

  return NextResponse.json({ models, default: defaultModel } satisfies ModelsResponse);
}
