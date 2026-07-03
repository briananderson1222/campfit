/**
 * /api/admin/crawl/models — the admin crawl-modal's model picker options.
 *
 * PROVIDER-CHOICE DECISION (traverse-recrawl-cutover plan, Task 1.4 / AC8):
 * the traverse-backed re-crawl path resolves its extraction provider via
 * datum (`lib/ingestion/resolve-extraction-provider.ts`) against
 * `.datum/config.json`'s `anthropic-compatible` providers — `@kontourai/traverse`
 * ships ONLY an Anthropic-compatible adapter (`./anthropic` export; no
 * Gemini/Ollama `ExtractionProvider` exists upstream, and campfit does not
 * fork one in-repo per consume-never-fork, ADR 0008/0010). The legacy
 * hardcoded Anthropic/Gemini/Ollama picker below therefore offered THREE
 * options traverse cannot honor for a migrated route (Gemini, both Ollama
 * entries) — a dead dropdown that silently no-ops when picked.
 *
 * DECISION: scope this endpoint to datum-registered `anthropic-compatible`
 * models only (read live from `.datum/config.json` via `@kontourai/datum`'s
 * `loadConfig()`), rather than badging/disabling the old hardcoded list.
 * Reading live (not a hardcoded copy) means the picker never drifts out of
 * sync with `.datum/config.json`'s actual registered providers/models —
 * whatever `resolveExtractionProvider()` can actually resolve is exactly
 * what this endpoint offers, so no option can silently no-op. Rationale
 * recorded here + in the durable migration doc (Task 3.3).
 */
import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { loadConfig, describeAuth, defaultSecretRunner } from '@kontourai/datum';

export interface LLMModel {
  /** datum model ref shape: "<model>@<providerId>" — what `TRAVERSE_ROLE`/a future per-run provider override would consume. */
  id: string;
  label: string;
  /** datum provider id (e.g. "zai", "anthropic") — open-ended, not a fixed union, since it's read live from `.datum/config.json`. */
  provider: string;
  badge: 'Key Set' | 'No Key';
}

export interface ModelsResponse {
  models: LLMModel[];
  default: string;
}

export async function GET() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { config } = loadConfig();
  const providers = config.providers ?? {};
  const models: LLMModel[] = [];

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    // traverse ships only the Anthropic-compatible adapter — see this file's
    // header doc and lib/ingestion/resolve-extraction-provider.ts.
    if (providerConfig.kind !== 'anthropic-compatible') continue;
    const status = describeAuth(providerConfig.auth, process.env, defaultSecretRunner);
    for (const model of providerConfig.models) {
      models.push({
        id: `${model}@${providerId}`,
        label: model,
        provider: providerId,
        badge: status.available ? 'Key Set' : 'No Key',
      });
    }
  }

  const defaultRole = config.roles?.['extraction-default'];
  const defaultModel =
    models.find((m) => m.id === defaultRole)?.id ??
    models.find((m) => m.badge === 'Key Set')?.id ??
    models[0]?.id ??
    '';

  return NextResponse.json({ models, default: defaultModel } satisfies ModelsResponse);
}
