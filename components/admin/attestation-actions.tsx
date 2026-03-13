'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

export function AttestationActions({
  attestationId,
  onUpdated,
  invalidationReason = 'Invalidated from trust ops',
}: {
  attestationId: string;
  onUpdated?: () => void;
  invalidationReason?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(action: 'recheck' | 'mark_stale' | 'invalidate') {
    setBusy(action);
    const res = await fetch(`/api/admin/attestations/${attestationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, invalidationReason }),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) {
      onUpdated?.();
      router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      <button onClick={() => submit('recheck')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5">
        {busy === 'recheck' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Recheck
      </button>
      <button onClick={() => submit('mark_stale')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5">
        {busy === 'mark_stale' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        Stale
      </button>
      <button onClick={() => submit('invalidate')} disabled={busy !== null} className="btn-secondary text-xs gap-1.5 text-red-600">
        {busy === 'invalidate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
        Invalidate
      </button>
    </div>
  );
}
