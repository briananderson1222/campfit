'use client';

/**
 * What keeps a camp from VERIFIED, in plain words, with the camp's own website
 * and phone so a steward can check the source or call. Values that can be
 * entered here are saved through POST /api/admin/camps/[campId]/steward-entry
 * and recorded as the steward's attestation (lib/admin/steward-entry.ts).
 * Shown on the admin camp page and the review page for a camp that is not
 * VERIFIED; the server decides what is listed (lib/admin/missing-requirements.ts).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ExternalLink, Loader2, Phone } from 'lucide-react';

import type { MissingCampRequirement, MissingRequirementsGuidance, MissingSessionRequirements } from '@/lib/admin/missing-requirements';
import { displayExternalUrl, safeExternalHref } from '@/lib/admin/safe-url';

function telHref(phone: string): string | undefined {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : undefined;
}

function formatDate(value: string | null): string {
  if (!value) return '?';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function postEntry(campId: string, body: Record<string, string>): Promise<string | null> {
  const res = await fetch(`/api/admin/camps/${campId}/steward-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (res?.ok) return null;
  const payload = await res?.json().catch(() => null) as { error?: string } | null | undefined;
  return payload?.error ?? 'The request failed. Nothing was saved.';
}

function SaveButton({ busy, label = 'Save as checked' }: { busy: boolean; label?: string }) {
  return (
    <button type="submit" disabled={busy}
      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-pine-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-pine-700 disabled:opacity-60">
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {label}
    </button>
  );
}

function CampFieldEntry({ campId, item }: { campId: string; item: MissingCampRequirement }) {
  const router = useRouter();
  const entry = item.entry!;
  const [value, setValue] = useState(entry.current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const failure = await postEntry(campId, { kind: 'camp-field', field: entry.field, value });
    setBusy(false);
    if (failure) setError(failure);
    else router.refresh();
  }

  const inputClass = 'w-full min-w-0 rounded-lg border border-cream-300 bg-white px-2.5 py-1.5 text-sm text-bark-700 dark:border-bark-500 dark:bg-bark-800 dark:text-cream-100';
  return (
    <form onSubmit={submit} className="mt-2 space-y-1.5" data-testid={`steward-entry-${entry.field}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {entry.input === 'select' ? (
          <select aria-label={item.title} value={value} onChange={(e) => setValue(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {entry.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : entry.input === 'textarea' ? (
          <textarea aria-label={item.title} value={value} onChange={(e) => setValue(e.target.value)} rows={3} className={inputClass} />
        ) : (
          <input aria-label={item.title} type={entry.input === 'url' ? 'url' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} className={inputClass} />
        )}
        <SaveButton busy={busy} />
      </div>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
    </form>
  );
}

function SessionTimeEntry({ campId, session }: { campId: string; session: MissingSessionRequirements }) {
  const router = useRouter();
  const [startTime, setStartTime] = useState(session.startTime ?? '');
  const [endTime, setEndTime] = useState(session.endTime ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const failure = await postEntry(campId, { kind: 'session-time', scheduleId: session.scheduleId, startTime, endTime });
    setBusy(false);
    if (failure) setError(failure);
    else router.refresh();
  }

  const inputClass = 'w-full min-w-0 rounded-lg border border-cream-300 bg-white px-2.5 py-1.5 text-sm text-bark-700 dark:border-bark-500 dark:bg-bark-800 dark:text-cream-100';
  return (
    <form onSubmit={submit} className="mt-2 space-y-1.5" data-testid={`session-time-entry-${session.scheduleId}`}>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
        <label className="text-xs text-bark-500 dark:text-cream-300">
          Starts
          <input value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="e.g. 9:00 AM" className={inputClass} />
        </label>
        <label className="text-xs text-bark-500 dark:text-cream-300">
          Ends
          <input value={endTime} onChange={(e) => setEndTime(e.target.value)} placeholder="e.g. 3:00 PM" className={inputClass} />
        </label>
        <div className="col-span-2 sm:col-span-1 sm:self-end">
          <SaveButton busy={busy} label="Save time as checked" />
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
    </form>
  );
}

/**
 * `'unavailable'`: the list could not be worked out. Said so, never shown as
 * "nothing missing".
 */
export function MissingRequirementsPanel({ guidance }: { guidance: MissingRequirementsGuidance | 'unavailable' | null }) {
  if (guidance === 'unavailable') {
    return (
      <p role="alert" data-testid="missing-requirements-unavailable"
        className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800/50 dark:bg-red-950 dark:text-red-300">
        Could not work out which requirements are still missing. Reload the page to try again.
      </p>
    );
  }
  if (!guidance || guidance.dataConfidence === 'VERIFIED') return null;
  const website = safeExternalHref(guidance.websiteUrl);
  const phone = guidance.contactPhone ? telHref(guidance.contactPhone) : undefined;
  const count = guidance.camp.length;

  return (
    <section data-testid="missing-requirements"
      className="rounded-2xl border border-amber-300/60 bg-amber-50/60 p-4 dark:border-amber-700/40 dark:bg-amber-900/10">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Not verified yet: {count} requirement{count === 1 ? '' : 's'} still missing
          </h2>
          <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
            Check the camp&apos;s own source, or call. A value you save here is recorded as checked by you.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {website ? (
              <a href={website} target="_blank" rel="noopener noreferrer" data-testid="missing-requirements-website"
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-pine-700 hover:text-pine-800 dark:bg-bark-800 dark:text-pine-300">
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{displayExternalUrl(guidance.websiteUrl!)}</span>
              </a>
            ) : (
              <span className="rounded-lg border border-amber-300 px-2.5 py-1 text-amber-900 dark:text-amber-200">No website on file</span>
            )}
            {phone ? (
              <a href={phone} data-testid="missing-requirements-phone"
                className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-pine-700 hover:text-pine-800 dark:bg-bark-800 dark:text-pine-300">
                <Phone className="h-3.5 w-3.5" />
                Call {guidance.contactPhone}
              </a>
            ) : (
              <span className="rounded-lg border border-amber-300 px-2.5 py-1 text-amber-900 dark:text-amber-200">No phone number on file</span>
            )}
          </div>

          <ul className="mt-3 space-y-3">
            {guidance.camp.map((item) => (
              <li key={item.requirementId} data-testid={`missing-${item.requirementId}`}
                className="rounded-xl border border-amber-200 bg-white/70 p-3 text-sm dark:border-amber-800/40 dark:bg-bark-800/60">
                <p className="font-semibold text-bark-700 dark:text-cream-100">{item.title}</p>
                <p className="mt-0.5 text-xs text-bark-500 dark:text-cream-300">{item.detail}</p>
                {item.entry && <CampFieldEntry campId={guidance.campId} item={item} />}
                {item.requirementId === 'sessions-verified' && guidance.sessions.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {guidance.sessions.map((session) => (
                      <li key={session.scheduleId} data-testid={`missing-session-${session.scheduleId}`}
                        className="rounded-lg border border-cream-300 p-2.5 dark:border-bark-500">
                        <p className="text-xs font-semibold text-bark-700 dark:text-cream-100">
                          {session.label || 'Session'}
                          <span className="ml-1 font-normal text-bark-400">{formatDate(session.startDate)} – {formatDate(session.endDate)}</span>
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {session.missing.map((item) => (
                            <li key={item.attribute} className="text-xs text-bark-500 dark:text-cream-300">
                              <span className="font-medium text-bark-600 dark:text-cream-200">{item.title}:</span> {item.detail}
                            </li>
                          ))}
                        </ul>
                        {session.timeEntry && <SessionTimeEntry campId={guidance.campId} session={session} />}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
