'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';

export function ReviewFlagActions({
  flagId,
  status,
  onUpdated,
}: {
  flagId: string;
  status: string;
  onUpdated?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(action: 'resolve' | 'dismiss' | 'reopen') {
    setBusy(action);
    const res = await fetch(`/api/admin/flags/${flagId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      onUpdated?.();
      router.refresh();
    }
  }

  if (status === 'OPEN') {
    return (
      <div className="flex flex-wrap gap-1">
        <button onClick={() => submit('resolve')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5">
          {busy === 'resolve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Resolve
        </button>
        <button onClick={() => submit('dismiss')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5 text-red-600">
          {busy === 'dismiss' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <button onClick={() => submit('reopen')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5">
      {busy === 'reopen' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
      Reopen
    </button>
  );
}
