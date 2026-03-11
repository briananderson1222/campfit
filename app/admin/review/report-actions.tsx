'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Loader2, ExternalLink } from 'lucide-react';

export function ReportActions({
  reportId, campId, campSlug, communitySlug,
}: {
  reportId: string; campId: string; campSlug: string; communitySlug: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<'reviewed' | 'dismissed' | null>(null);

  async function act(status: 'REVIEWED' | 'DISMISSED') {
    setLoading(status === 'REVIEWED' ? 'reviewed' : 'dismissed');
    await fetch(`/api/admin/reports/${reportId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => null);
    setLoading(null);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <a
        href={`/c/${communitySlug}/camps/${campSlug}`}
        target="_blank"
        rel="noopener noreferrer"
        title="View public page"
        className="p-1.5 rounded-lg text-bark-300 hover:text-pine-500 hover:bg-pine-50 transition-colors"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
      <button
        onClick={() => act('REVIEWED')}
        disabled={!!loading}
        title="Mark reviewed"
        className="p-1.5 rounded-lg text-bark-300 hover:text-pine-600 hover:bg-pine-50 disabled:opacity-40 transition-colors"
      >
        {loading === 'reviewed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
      </button>
      <button
        onClick={() => act('DISMISSED')}
        disabled={!!loading}
        title="Dismiss"
        className="p-1.5 rounded-lg text-bark-300 hover:text-red-400 hover:bg-red-50 disabled:opacity-40 transition-colors"
      >
        {loading === 'dismissed' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
