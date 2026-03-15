'use client';

import { useState } from 'react';
import { Bot, Loader2, MessageCircle, Minimize2, Sparkles, X } from 'lucide-react';
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
  const [open, setOpen] = useState(false);
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
    <>
      <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
        {open && (
          <div className="w-[min(92vw,420px)] overflow-hidden rounded-3xl border border-cream-300/80 bg-[#fbf6ec]/95 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-cream-300/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="rounded-full bg-pine-600 p-2 text-cream-50">
                  <Bot className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-bark-700">Admin copilot</div>
                  <div className="text-[11px] text-bark-400">Tool-enabled chat for this record</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-full p-2 text-bark-400 transition-colors hover:bg-cream-100 hover:text-bark-600"
                  title="Minimize"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-full p-2 text-bark-400 transition-colors hover:bg-cream-100 hover:text-bark-600"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="space-y-3 p-4">
              <div className="max-h-[48vh] space-y-2 overflow-y-auto rounded-2xl bg-cream-50/80 p-3">
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}-${index}`}
                    className={cn(
                      'max-w-[92%] rounded-2xl px-3 py-2 text-sm',
                      message.role === 'assistant' ? 'bg-white text-bark-600 shadow-sm' : 'ml-auto bg-pine-600 text-cream-50',
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
                className="w-full rounded-2xl border border-cream-300 bg-white px-3 py-2 text-sm"
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
          </div>
        )}

        <button
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'flex items-center gap-2 rounded-full px-4 py-3 text-sm font-semibold shadow-lg transition-colors',
            open ? 'bg-bark-700 text-cream-50' : 'bg-pine-600 text-cream-50 hover:bg-pine-700',
          )}
        >
          <MessageCircle className="h-4 w-4" />
          {open ? 'Hide copilot' : 'Admin copilot'}
        </button>
      </div>
    </>
  );
}
