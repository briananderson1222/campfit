'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Archive, Flag, Loader2, Plus, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ReviewFlagActions } from './review-flag-actions';
import { AdminCopilot } from './admin-copilot';

type EntityType = 'CAMP' | 'PROVIDER';

type ContextPayload = {
  snapshot: {
    archivedAt?: string | null;
    archiveReason?: string | null;
  };
  flags: Array<{ id: string; comment: string; status: string; createdAt: string }>;
  attestations: Array<{
    id: string;
    fieldKey: string;
    approvedAt: string | null;
    status: string;
    notes?: string | null;
    invalidationReason?: string | null;
    lastRecheckedAt?: string | null;
  }>;
  people: Array<{
    id: string;
    roleId?: string;
    fullName?: string;
    title?: string | null;
    roleType?: string | null;
    contacts?: Array<{ type: string; value: string }>;
  }>;
  accreditations: Array<{
    id: string;
    bodyName?: string;
    status?: string | null;
    scope?: string | null;
    lastVerifiedAt?: string | null;
    expiresAt?: string | null;
    notes?: string | null;
  }>;
  aiActions: Array<{ id: string; action: string; capability: string; status: string; createdAt: string }>;
};

type RelatedCamp = {
  id: string;
  name: string;
  slug: string;
  city?: string | null;
  state?: string | null;
  lastVerifiedAt?: string | null;
};

export function EntityOpsPanel({
  entityType,
  entityId,
  allowAccreditation = false,
}: {
  entityType: EntityType;
  entityId: string;
  allowAccreditation?: boolean;
}) {
  const [context, setContext] = useState<ContextPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [flagComment, setFlagComment] = useState('');
  const [personName, setPersonName] = useState('');
  const [personTitle, setPersonTitle] = useState('');
  const [accreditationBody, setAccreditationBody] = useState('');
  const [accreditationScope, setAccreditationScope] = useState('');
  const [accreditationEdits, setAccreditationEdits] = useState<Record<string, { scope: string; notes: string; expiresAt: string }>>({});
  const [relatedCamps, setRelatedCamps] = useState<RelatedCamp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadContext() {
    setLoading(true);
    const res = await fetch(`/api/admin/entities/${entityType.toLowerCase()}/${entityId}`).catch(() => null);
    const data = await res?.json().catch(() => null);
    setLoading(false);
    if (!res?.ok || !data) {
      setError(data?.error ?? 'Failed to load entity admin context');
      return;
    }
    setError(null);
    setContext(data);
  }

  useEffect(() => {
    loadContext().catch(() => {});
  }, [entityId, entityType]);

  async function runEntityAction(body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    const res = await fetch(`/api/admin/entities/${entityType.toLowerCase()}/${entityId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(data?.error ?? 'Request failed');
      return;
    }
    await loadContext();
  }

  async function loadRelatedCamps() {
    setBusy('related');
    setError(null);
    const res = await fetch(`/api/admin/entities/${entityType.toLowerCase()}/${entityId}?include=related-camps`).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(data?.error ?? 'Failed to load related camps');
      return;
    }
    setRelatedCamps(Array.isArray(data?.relatedCamps) ? data.relatedCamps as RelatedCamp[] : []);
  }

  async function patchAccreditation(accreditationId: string, body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    const res = await fetch(`/api/admin/accreditations/${accreditationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(data?.error ?? 'Failed to update accreditation');
      return;
    }
    await loadContext();
  }

  function accreditationDraft(accreditation: ContextPayload['accreditations'][number]) {
    return accreditationEdits[accreditation.id] ?? {
      scope: accreditation.scope ?? '',
      notes: accreditation.notes ?? '',
      expiresAt: accreditation.expiresAt ? String(accreditation.expiresAt).split('T')[0] : '',
    };
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <div className="glass-panel p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-bark-400" />
          <h3 className="font-display text-sm font-bold uppercase tracking-wide text-bark-700">Admin Status</h3>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-bark-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading context…
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-cream-300/70 px-3 py-2 text-sm text-bark-500">
              Status:{' '}
              <span className={cn('font-semibold', context?.snapshot.archivedAt ? 'text-red-600' : 'text-pine-600')}>
                {context?.snapshot.archivedAt ? 'Archived' : 'Active'}
              </span>
              {context?.snapshot.archiveReason && (
                <span className="text-xs text-bark-400"> · {context.snapshot.archiveReason}</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => runEntityAction({ action: context?.snapshot.archivedAt ? 'unarchive' : 'archive', reason: 'Changed from admin status panel' }, 'archive')}
                disabled={busy !== null}
                className="btn-secondary gap-2"
              >
                {busy === 'archive' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                {context?.snapshot.archivedAt ? 'Restore' : 'Archive'}
              </button>
              <button
                onClick={() => loadRelatedCamps()}
                disabled={busy !== null}
                className="btn-secondary gap-2"
              >
                {busy === 'related' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                Show related camps
              </button>
            </div>

            {relatedCamps && (
              <div className="space-y-2 rounded-xl border border-cream-300/70 p-3">
                <div className="text-sm font-semibold text-bark-600">Related camps</div>
                {relatedCamps.length === 0 ? (
                  <p className="text-sm text-bark-400">No related camps found.</p>
                ) : (
                  <div className="space-y-2">
                    {relatedCamps.map((camp) => (
                      <Link
                        key={camp.id}
                        href={`/admin/camps/${camp.id}`}
                        className="block rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600 transition-colors hover:border-pine-300 hover:text-pine-600"
                      >
                        <div className="font-medium">{camp.name}</div>
                        <div className="text-xs text-bark-400">
                          {[camp.city, camp.state].filter(Boolean).join(', ') || 'No location set'}
                          {camp.lastVerifiedAt ? ` · verified ${new Date(camp.lastVerifiedAt).toLocaleDateString()}` : ' · never verified'}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Flag className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-bark-600">Review flags</span>
              </div>
              <div className="space-y-2">
                {(context?.flags ?? []).map((flag) => (
                  <div key={flag.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div>{flag.comment}</div>
                        <div className="mt-1 text-xs text-amber-700">{flag.status}</div>
                      </div>
                      <ReviewFlagActions flagId={flag.id} status={flag.status} onUpdated={loadContext} />
                    </div>
                  </div>
                ))}
                <textarea
                  value={flagComment}
                  onChange={(event) => setFlagComment(event.target.value)}
                  rows={2}
                  placeholder="Flag this entity for later review…"
                  className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
                />
                <button
                  onClick={async () => {
                    await runEntityAction({ action: 'flag', comment: flagComment }, 'flag');
                    setFlagComment('');
                  }}
                  disabled={!flagComment.trim() || busy !== null}
                  className="btn-secondary gap-2"
                >
                  {busy === 'flag' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Add flag
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </>
        )}
      </div>

      <div className="space-y-5">
        <div className="glass-panel p-5 space-y-5">
          <div className="rounded-xl border border-cream-300/70 p-3 text-xs text-bark-500">
            Use the inline <span className="font-semibold">Attest</span> buttons next to each camp field or section. This side panel is only for linked records and admin tools.
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-pine-500" />
              <span className="text-sm font-semibold text-bark-600">People</span>
            </div>
            {(context?.people ?? []).map((person) => (
              <Link
                key={person.roleId ?? person.id}
                href={`/admin/people/${person.id}`}
                className="block rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600 transition-colors hover:border-pine-300 hover:text-pine-600"
              >
                <span className="font-medium">{person.fullName ?? 'Person'}</span>
                {(person.title || person.roleType) && <span className="text-bark-400"> · {person.title ?? person.roleType}</span>}
              </Link>
            ))}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input value={personName} onChange={(event) => setPersonName(event.target.value)} placeholder="Full name" className="rounded-lg border border-cream-300 px-3 py-2 text-sm" />
              <input value={personTitle} onChange={(event) => setPersonTitle(event.target.value)} placeholder="Title" className="rounded-lg border border-cream-300 px-3 py-2 text-sm" />
            </div>
            <button
              onClick={async () => {
                await runEntityAction({ action: 'add_person', fullName: personName, title: personTitle }, 'person');
                setPersonName('');
                setPersonTitle('');
              }}
              disabled={!personName.trim() || busy !== null}
              className="btn-secondary gap-2"
            >
              {busy === 'person' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add person
            </button>
          </div>

          {allowAccreditation && (
            <div className="space-y-2">
              <span className="text-sm font-semibold text-bark-600">Accreditation</span>
              {(context?.accreditations ?? []).map((accreditation) => {
                const draft = accreditationDraft(accreditation);
                return (
                  <div key={accreditation.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">{accreditation.bodyName}</span>
                        {(accreditation.status || accreditation.scope) && (
                          <span className="text-bark-400"> · {accreditation.status ?? accreditation.scope}</span>
                        )}
                        {accreditation.lastVerifiedAt && (
                          <div className="mt-1 text-xs text-bark-400">Verified {new Date(accreditation.lastVerifiedAt).toLocaleDateString()}</div>
                        )}
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        <button onClick={() => patchAccreditation(accreditation.id, { status: 'ACTIVE', lastVerifiedAt: new Date().toISOString() }, `acc-${accreditation.id}-active`)} disabled={busy !== null} className="btn-secondary text-xs">Verify</button>
                        <button onClick={() => patchAccreditation(accreditation.id, { status: 'STALE' }, `acc-${accreditation.id}-stale`)} disabled={busy !== null} className="btn-secondary text-xs">Stale</button>
                        <button onClick={() => patchAccreditation(accreditation.id, { status: 'EXPIRED' }, `acc-${accreditation.id}-expired`)} disabled={busy !== null} className="btn-secondary text-xs text-red-600">Expire</button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      <input
                        value={draft.scope}
                        onChange={(event) => setAccreditationEdits((current) => ({ ...current, [accreditation.id]: { ...draft, scope: event.target.value } }))}
                        placeholder="Scope"
                        className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                      />
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <input
                          type="date"
                          value={draft.expiresAt}
                          onChange={(event) => setAccreditationEdits((current) => ({ ...current, [accreditation.id]: { ...draft, expiresAt: event.target.value } }))}
                          className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                        />
                        <button
                          onClick={() => patchAccreditation(accreditation.id, { scope: draft.scope || null, notes: draft.notes || null, expiresAt: draft.expiresAt || null }, `acc-${accreditation.id}-save`)}
                          disabled={busy !== null}
                          className="btn-secondary text-xs"
                        >
                          Save details
                        </button>
                      </div>
                      <textarea
                        value={draft.notes}
                        onChange={(event) => setAccreditationEdits((current) => ({ ...current, [accreditation.id]: { ...draft, notes: event.target.value } }))}
                        rows={2}
                        placeholder="Notes"
                        className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                );
              })}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input value={accreditationBody} onChange={(event) => setAccreditationBody(event.target.value)} placeholder="Accreditation body" className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm" />
                <input value={accreditationScope} onChange={(event) => setAccreditationScope(event.target.value)} placeholder="Scope (optional)" className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm" />
              </div>
              <button
                onClick={async () => {
                  await runEntityAction({ action: 'add_accreditation', bodyName: accreditationBody, scope: accreditationScope || null }, 'accreditation');
                  setAccreditationBody('');
                  setAccreditationScope('');
                }}
                disabled={!accreditationBody.trim() || busy !== null}
                className="btn-secondary gap-2"
              >
                {busy === 'accreditation' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add accreditation
              </button>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-sm font-semibold text-bark-600">Recent AI actions</span>
            <div className="space-y-2">
              {(context?.aiActions ?? []).slice(0, 5).map((action) => (
                <div key={action.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
                  <div className="font-medium">{action.action}</div>
                  <div className="text-xs text-bark-400">{action.capability} · {action.status}</div>
                </div>
              ))}
              {!(context?.aiActions.length) && (
                <p className="text-sm text-bark-300">No AI actions recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      <AdminCopilot entityType={entityType} entityId={entityId} onContextChanged={loadContext} />
    </div>
  );
}
