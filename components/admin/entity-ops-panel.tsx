'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Archive, Bot, Flag, Loader2, Plus, ShieldCheck, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AttestationActions } from './attestation-actions';
import { ReviewFlagActions } from './review-flag-actions';

type EntityType = 'CAMP' | 'PROVIDER';
type AssistantActionOption =
  | 'propose'
  | 'flag'
  | 'attest'
  | 'add_person'
  | 'add_accreditation'
  | 'mark_verified'
  | 'trigger_crawl'
  | 'archive'
  | 'restore';

type ContextPayload = {
  snapshot: {
    archivedAt?: string | null;
    archiveReason?: string | null;
  };
  flags: Array<{ id: string; comment: string; status: string; createdAt: string }>;
  attestations: Array<{ id: string; fieldKey: string; approvedAt: string | null; status: string; notes?: string | null; invalidationReason?: string | null; lastRecheckedAt?: string | null }>;
  people: Array<{ id: string; roleId?: string; fullName?: string; title?: string | null; roleType?: string | null; contacts?: Array<{ type: string; value: string }> }>;
  accreditations: Array<{ id: string; bodyName?: string; status?: string | null; scope?: string | null; lastVerifiedAt?: string | null; expiresAt?: string | null; notes?: string | null }>;
  aiActions: Array<{ id: string; action: string; capability: string; status: string; createdAt: string }>;
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
  const [accreditationEdits, setAccreditationEdits] = useState<Record<string, {
    scope: string;
    notes: string;
    expiresAt: string;
  }>>({});
  const [attestationField, setAttestationField] = useState('');
  const [attestationSourceUrl, setAttestationSourceUrl] = useState('');
  const [attestationNotes, setAttestationNotes] = useState('');
  const [assistantAction, setAssistantAction] = useState<AssistantActionOption>('propose');
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantResult, setAssistantResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<{ action: string; payload: Record<string, unknown> } | null>(null);

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
  }, [entityType, entityId]);

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

  async function runAssistant(action: string, payload: Record<string, unknown>, confirmed = false) {
    setBusy('assistant');
    setAssistantResult(null);
    setError(null);
    const res = await fetch('/api/admin/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, entityType, entityId, payload, confirmed }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(data?.error ?? 'Assistant action failed');
      return;
    }
    if (data?.requiresConfirmation) {
      setPendingAssistant({ action, payload });
      setAssistantResult(`Confirmation required for ${action}. Review and confirm below.`);
      return;
    }
    setPendingAssistant(null);
    setAssistantResult(JSON.stringify(data.output ?? data, null, 2));
    await loadContext();
  }

  async function patchAttestation(attestationId: string, body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    const res = await fetch(`/api/admin/attestations/${attestationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(data?.error ?? 'Failed to update attestation');
      return;
    }
    await loadContext();
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

  async function refreshContext() {
    await loadContext();
  }

  function assistantPlaceholder() {
    switch (assistantAction) {
      case 'propose':
        return 'Describe the provider/camp change you want proposed.';
      case 'flag':
        return 'Describe why this entity should be flagged.';
      case 'attest':
        return 'Field key, source note, or rationale for the attestation.';
      case 'add_person':
        return 'Person name, title, and any useful context.';
      case 'add_accreditation':
        return 'Accreditation body and optional scope.';
      case 'archive':
      case 'restore':
        return 'Optional reason for this archive state change.';
      case 'mark_verified':
        return 'Optional note before marking verified.';
      case 'trigger_crawl':
        return 'Optional crawl note.';
      default:
        return 'Describe the action you want the assistant to take.';
    }
  }

  function accreditationDraft(accreditation: ContextPayload['accreditations'][number]) {
    return accreditationEdits[accreditation.id] ?? {
      scope: accreditation.scope ?? '',
      notes: accreditation.notes ?? '',
      expiresAt: accreditation.expiresAt ? String(accreditation.expiresAt).split('T')[0] : '',
    };
  }

  async function runSelectedAssistantAction() {
    const prompt = assistantPrompt.trim();
    switch (assistantAction) {
      case 'propose':
        await runAssistant(entityType === 'CAMP' ? 'propose_camp_changes' : 'propose_provider_changes', {
          reviewerNotes: prompt || null,
          proposedChanges: {
            notes: {
              old: null,
              new: prompt,
              confidence: 0.5,
            },
          },
        });
        break;
      case 'flag':
        await runAssistant('flag_entity', { comment: prompt });
        break;
      case 'attest':
        await runAssistant('add_attestation', {
          fieldKey: attestationField || prompt,
          sourceUrl: attestationSourceUrl || null,
          notes: attestationNotes || prompt || null,
        });
        break;
      case 'add_person':
        await runAssistant('add_person', {
          fullName: personName || prompt,
          title: personTitle || null,
          notes: prompt || null,
        });
        break;
      case 'add_accreditation':
        await runAssistant('add_accreditation', {
          bodyName: accreditationBody || prompt,
          scope: accreditationScope || null,
          notes: prompt || null,
        });
        break;
      case 'mark_verified':
        await runAssistant('mark_camp_verified', { note: prompt || null });
        break;
      case 'trigger_crawl':
        await runAssistant(entityType === 'CAMP' ? 'trigger_camp_crawl' : 'trigger_provider_crawl', { note: prompt || null });
        break;
      case 'archive':
        await runAssistant('archive_entity', { reason: prompt || 'Archived from assistant console' });
        break;
      case 'restore':
        await runAssistant('restore_entity', { reason: prompt || null });
        break;
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <div className="glass-panel p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Archive className="w-4 h-4 text-bark-400" />
          <h3 className="font-display font-bold text-bark-700 text-sm uppercase tracking-wide">Admin Ops</h3>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-bark-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading context…</div>
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
                onClick={() => runEntityAction({ action: context?.snapshot.archivedAt ? 'unarchive' : 'archive', reason: 'Archived from admin entity panel' }, 'archive')}
                disabled={busy !== null}
                className="btn-secondary gap-2"
              >
                {busy === 'archive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                {context?.snapshot.archivedAt ? 'Restore' : 'Archive'}
              </button>
              <button
                onClick={() => runAssistant('get_connected_camps', {}, false)}
                disabled={busy !== null}
                className="btn-secondary gap-2"
              >
                {busy === 'assistant' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
                Load related context
              </button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Flag className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-semibold text-bark-600">Review flags</span>
              </div>
              <div className="space-y-2">
                {(context?.flags ?? []).map(flag => (
                  <div key={flag.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div>{flag.comment}</div>
                        <div className="mt-1 text-xs text-amber-700">{flag.status}</div>
                      </div>
                      <ReviewFlagActions flagId={flag.id} status={flag.status} onUpdated={refreshContext} />
                    </div>
                  </div>
                ))}
                <textarea
                  value={flagComment}
                  onChange={e => setFlagComment(e.target.value)}
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
                  {busy === 'flag' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add flag
                </button>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </>
        )}
      </div>

      <div className="glass-panel p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-pine-500" />
          <h3 className="font-display font-bold text-bark-700 text-sm uppercase tracking-wide">People & Trust</h3>
        </div>

        <div className="space-y-2">
          {(context?.people ?? []).map(person => (
            <Link key={person.roleId ?? person.id} href={`/admin/people/${person.id}`} className="block rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600 hover:border-pine-300 hover:text-pine-600">
              <span className="font-medium">{person.fullName ?? 'Person'}</span>
              {(person.title || person.roleType) && (
                <span className="text-bark-400"> · {person.title ?? person.roleType}</span>
              )}
            </Link>
          ))}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={personName} onChange={e => setPersonName(e.target.value)} placeholder="Full name" className="rounded-lg border border-cream-300 px-3 py-2 text-sm" />
            <input value={personTitle} onChange={e => setPersonTitle(e.target.value)} placeholder="Title" className="rounded-lg border border-cream-300 px-3 py-2 text-sm" />
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
            {busy === 'person' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add person
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-pine-500" />
            <span className="text-sm font-semibold text-bark-600">Attestations</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input value={attestationField} onChange={e => setAttestationField(e.target.value)} placeholder="Field key" className="rounded-lg border border-cream-300 px-3 py-2 text-sm" />
            <input value={attestationSourceUrl} onChange={e => setAttestationSourceUrl(e.target.value)} placeholder="Source URL (optional)" className="rounded-lg border border-cream-300 px-3 py-2 text-sm sm:col-span-2" />
          </div>
          <textarea value={attestationNotes} onChange={e => setAttestationNotes(e.target.value)} rows={2} placeholder="Attestation notes" className="w-full rounded-lg border border-cream-300 px-3 py-2 text-sm" />
          <button
            onClick={async () => {
              await runEntityAction({
                action: 'attest',
                fieldKey: attestationField,
                sourceUrl: attestationSourceUrl || null,
                notes: attestationNotes || null,
              }, 'attest');
              setAttestationField('');
              setAttestationSourceUrl('');
              setAttestationNotes('');
            }}
            disabled={!attestationField.trim() || busy !== null}
            className="btn-secondary gap-2"
          >
            {busy === 'attest' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add attestation
          </button>
          <div className="space-y-2">
            {(context?.attestations ?? []).slice(0, 12).map(att => (
              <div key={att.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{att.fieldKey}</div>
                    <div className="text-xs text-bark-400">{att.status}{att.lastRecheckedAt ? ` · rechecked ${new Date(att.lastRecheckedAt).toLocaleDateString()}` : ''}</div>
                    {att.invalidationReason && <div className="text-xs text-red-500 mt-1">{att.invalidationReason}</div>}
                  </div>
                  <AttestationActions attestationId={att.id} onUpdated={refreshContext} invalidationReason="Invalidated from entity panel" />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-pine-500" />
            <span className="text-sm font-semibold text-bark-600">Recent AI Actions</span>
          </div>
          <div className="space-y-2">
            {(context?.aiActions ?? []).slice(0, 5).map(action => (
              <div key={action.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
                <div className="font-medium">{action.action}</div>
                <div className="text-xs text-bark-400">{action.capability} · {action.status}</div>
              </div>
            ))}
            {!(context?.aiActions?.length) && (
              <p className="text-sm text-bark-300">No AI actions recorded yet.</p>
            )}
          </div>
        </div>

        {allowAccreditation && (
          <div className="space-y-2">
            <span className="text-sm font-semibold text-bark-600">Accreditation</span>
            {(context?.accreditations ?? []).map(accreditation => (
              <div key={accreditation.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
                {(() => {
                  const draft = accreditationDraft(accreditation);
                  return (
                    <>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{accreditation.bodyName}</span>
                    {(accreditation.status || accreditation.scope) && (
                      <span className="text-bark-400"> · {accreditation.status ?? accreditation.scope}</span>
                    )}
                    {accreditation.lastVerifiedAt && (
                      <div className="text-xs text-bark-400 mt-1">Verified {new Date(accreditation.lastVerifiedAt).toLocaleDateString()}</div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 justify-end">
                    <button onClick={() => patchAccreditation(accreditation.id, { status: 'ACTIVE', lastVerifiedAt: new Date().toISOString() }, `acc-${accreditation.id}-active`)} disabled={busy !== null} className="btn-secondary text-xs">Verify</button>
                    <button onClick={() => patchAccreditation(accreditation.id, { status: 'STALE' }, `acc-${accreditation.id}-stale`)} disabled={busy !== null} className="btn-secondary text-xs">Stale</button>
                    <button onClick={() => patchAccreditation(accreditation.id, { status: 'EXPIRED' }, `acc-${accreditation.id}-expired`)} disabled={busy !== null} className="btn-secondary text-xs text-red-600">Expire</button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2">
                  <input
                    value={draft.scope}
                    onChange={e => setAccreditationEdits(prev => ({ ...prev, [accreditation.id]: { ...draft, scope: e.target.value } }))}
                    placeholder="Scope"
                    className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="date"
                      value={draft.expiresAt}
                      onChange={e => setAccreditationEdits(prev => ({ ...prev, [accreditation.id]: { ...draft, expiresAt: e.target.value } }))}
                      className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                    />
                    <button
                      onClick={() => patchAccreditation(accreditation.id, {
                        scope: draft.scope || null,
                        notes: draft.notes || null,
                        expiresAt: draft.expiresAt || null,
                      }, `acc-${accreditation.id}-save`)}
                      disabled={busy !== null}
                      className="btn-secondary text-xs"
                    >
                      Save details
                    </button>
                  </div>
                  <textarea
                    value={draft.notes}
                    onChange={e => setAccreditationEdits(prev => ({ ...prev, [accreditation.id]: { ...draft, notes: e.target.value } }))}
                    rows={2}
                    placeholder="Notes"
                    className="rounded-lg border border-cream-300 px-3 py-2 text-sm"
                  />
                </div>
                    </>
                  );
                })()}
              </div>
            ))}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={accreditationBody} onChange={e => setAccreditationBody(e.target.value)} placeholder="Accreditation body" className="rounded-lg border border-cream-300 px-3 py-2 text-sm w-full" />
              <input value={accreditationScope} onChange={e => setAccreditationScope(e.target.value)} placeholder="Scope (optional)" className="rounded-lg border border-cream-300 px-3 py-2 text-sm w-full" />
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
              {busy === 'accreditation' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add accreditation
            </button>
          </div>
        )}

        <div className="rounded-xl border border-cream-300/70 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-pine-500" />
            <span className="text-sm font-semibold text-bark-600">Admin assistant</span>
          </div>
          <select
            value={assistantAction}
            onChange={e => setAssistantAction(e.target.value as AssistantActionOption)}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          >
            <option value="propose">Draft proposal</option>
            <option value="flag">Flag entity</option>
            <option value="attest">Add attestation</option>
            <option value="add_person">Add person</option>
            {allowAccreditation && <option value="add_accreditation">Add accreditation</option>}
            {entityType === 'CAMP' && <option value="mark_verified">Mark verified</option>}
            <option value="trigger_crawl">Trigger crawl</option>
            <option value="archive">Archive entity</option>
            <option value="restore">Restore entity</option>
          </select>
          <textarea
            value={assistantPrompt}
            onChange={e => setAssistantPrompt(e.target.value)}
            rows={4}
            placeholder={assistantPlaceholder()}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => runSelectedAssistantAction()}
              disabled={(
                (assistantAction === 'propose' || assistantAction === 'flag' || assistantAction === 'archive') && !assistantPrompt.trim()
              ) || (
                assistantAction === 'attest' && !(attestationField.trim() || assistantPrompt.trim())
              ) || (
                assistantAction === 'add_person' && !(personName.trim() || assistantPrompt.trim())
              ) || (
                assistantAction === 'add_accreditation' && !(accreditationBody.trim() || assistantPrompt.trim())
              ) || busy !== null}
              className="btn-primary gap-2"
            >
              {busy === 'assistant' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />}
              Run assistant action
            </button>
          </div>
          {pendingAssistant && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-2">
              <p>Pending confirmation for <span className="font-semibold">{pendingAssistant.action}</span>.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => runAssistant(pendingAssistant.action, pendingAssistant.payload, true)}
                  disabled={busy !== null}
                  className="btn-primary gap-2"
                >
                  Confirm action
                </button>
                <button
                  onClick={() => { setPendingAssistant(null); setAssistantResult('Assistant action canceled.'); }}
                  disabled={busy !== null}
                  className="btn-secondary gap-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {assistantResult && (
            <pre className="max-h-64 overflow-auto rounded-lg bg-bark-700 p-3 text-xs text-cream-100">{assistantResult}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
