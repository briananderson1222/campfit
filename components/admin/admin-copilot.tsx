'use client';

import { useState } from 'react';
import { Bot, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

type Message = {
  role: 'user' | 'assistant';
  content: string;
};

type PendingConfirmation = {
  action: string;
  payload: Record<string, unknown>;
  label: string;
};

type AssistantResponse = {
  error?: string;
  reply?: string;
  output?: { runId?: string };
  requiresConfirmation?: boolean;
  confirmation?: {
    action: string;
    payload?: Record<string, unknown>;
    label?: string;
  };
  contextChanged?: boolean;
};

const STARTERS = [
  'Show related camps',
  'What trust data is stale here?',
  'Summarize pending flags and attestations',
  'Trigger a recrawl for this record',
];

export function AdminCopilot({
  entityType,
  entityId,
  onContextChanged,
}: {
  entityType: 'CAMP' | 'PROVIDER';
  entityId: string;
  onContextChanged?: () => Promise<void> | void;
}) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Ask about this record or request an admin action. I can inspect related records, summarize trust state, and prepare writes for confirmation.',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(message: string, confirm?: PendingConfirmation) {
    const trimmed = message.trim();
    if (!trimmed && !confirm) return;

    if (!confirm) {
      setMessages((current) => [...current, { role: 'user', content: trimmed }]);
      setInput('');
    }
    setBusy(true);
    setError(null);

    const payload = confirm
      ? { action: confirm.action, entityType, entityId, payload: confirm.payload, confirmed: true }
      : { action: 'chat_entity', entityType, entityId, payload: { message: trimmed } };

    const res = await fetch('/api/admin/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const rawText = await res?.text().catch(() => '') ?? '';
    const data = rawText
      ? (() => {
          try {
            return JSON.parse(rawText) as AssistantResponse;
          } catch {
            return null;
          }
        })()
      : null;
    setBusy(false);

    if (!res?.ok || !data) {
      const errorMessage = typeof data?.error === 'string'
        ? data.error
        : rawText || 'Assistant request failed';
      setError(errorMessage);
      return;
    }

    if (confirm) {
      setPendingConfirmation(null);
      await onContextChanged?.();
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: typeof data.reply === 'string'
            ? data.reply
            : typeof (data.output as { runId?: unknown } | undefined)?.runId === 'string'
              ? `Action started. Run id: ${(data.output as { runId: string }).runId}`
              : 'Action completed.',
        },
      ]);
      return;
    }

    if (data.requiresConfirmation) {
      setPendingConfirmation({
        action: data.confirmation?.action ?? '',
        payload: data.confirmation?.payload ?? {},
        label: data.confirmation?.label ?? 'Confirm action',
      });
    } else {
      setPendingConfirmation(null);
    }

    setMessages((current) => [
      ...current,
      { role: 'assistant', content: typeof data.reply === 'string' ? data.reply : 'I reviewed the current admin context.' },
    ]);

    if (data.contextChanged) {
      await onContextChanged?.();
    }
  }

  return (
    <div className="rounded-xl border border-cream-300/70 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-pine-500" />
        <span className="text-sm font-semibold text-bark-600">Admin copilot</span>
      </div>

      <div className="space-y-2 rounded-xl bg-cream-50/70 p-3">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              'max-w-[90%] rounded-2xl px-3 py-2 text-sm',
              message.role === 'assistant' ? 'bg-white text-bark-600' : 'ml-auto bg-pine-600 text-cream-50',
            )}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-bark-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {STARTERS.map((starter) => (
          <button
            key={starter}
            onClick={() => sendMessage(starter)}
            disabled={busy}
            className="rounded-full border border-cream-300 bg-white px-3 py-1.5 text-xs font-medium text-bark-500 transition-colors hover:border-pine-300 hover:text-pine-600"
          >
            <Sparkles className="mr-1 inline h-3 w-3" />
            {starter}
          </button>
        ))}
      </div>

      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        rows={3}
        placeholder="Ask a question or request an action, for example: 'archive this provider because the site is gone' or 'show related camps'."
        className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
      />

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => sendMessage(input)}
          disabled={busy || !input.trim()}
          className="btn-secondary"
        >
          Send
        </button>
        {pendingConfirmation && (
          <button
            onClick={() => sendMessage('', pendingConfirmation)}
            disabled={busy}
            className="rounded-lg bg-pine-600 px-3 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700"
          >
            {pendingConfirmation.label}
          </button>
        )}
      </div>

      {pendingConfirmation && (
        <p className="text-xs text-amber-700">
          Confirmation is required before the requested write action is applied.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
