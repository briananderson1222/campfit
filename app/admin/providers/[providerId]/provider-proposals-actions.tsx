'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Loader2, X } from 'lucide-react';
import { useState } from 'react';

export function ProviderProposalActions({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);

  async function submit(action: 'approve' | 'reject') {
    setLoading(action);
    const res = await fetch(`/api/admin/provider-proposals/${proposalId}/${action}`, {
      method: 'POST',
    }).catch(() => null);
    setLoading(null);
    if (res?.ok) router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Link href={`/admin/provider-review/${proposalId}`} className="btn-secondary gap-1.5 text-xs">
        Review
      </Link>
      <button onClick={() => submit('approve')} disabled={loading !== null} className="btn-secondary gap-1.5 text-xs">
        {loading === 'approve' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        Approve
      </button>
      <button onClick={() => submit('reject')} disabled={loading !== null} className="btn-secondary gap-1.5 text-xs text-red-600">
        {loading === 'reject' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        Reject
      </button>
    </div>
  );
}
