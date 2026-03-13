'use client';

import { useRouter } from 'next/navigation';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

export function PersonRoleActions({
  roleType,
  roleId,
}: {
  roleType: 'camp' | 'provider';
  roleId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const res = await fetch(`/api/admin/people/roles/${roleType}/${roleId}`, {
      method: 'DELETE',
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) router.refresh();
  }

  return (
    <button onClick={remove} disabled={busy} className="btn-secondary text-xs gap-1.5 text-red-600">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      Remove
    </button>
  );
}
