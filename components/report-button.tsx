'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Flag, X, Loader2, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const REPORT_TYPES = [
  { value: 'WRONG_INFO',    label: 'Wrong information',           desc: 'Price, dates, ages, or details are incorrect' },
  { value: 'MISSING_INFO',  label: 'Missing information',         desc: 'Key details are absent or incomplete' },
  { value: 'CAMP_CLOSED',   label: 'Camp no longer offered',      desc: 'This program has been cancelled or discontinued' },
  { value: 'OTHER',         label: 'Other',                       desc: 'Something else isn\'t right' },
] as const;

type ReportType = typeof REPORT_TYPES[number]['value'];

export function ReportButton({ campId }: { campId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ReportType>('WRONG_INFO');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/camps/${campId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, description }),
      });
      if (res.status === 401) {
        router.push('/auth/login');
        return;
      }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Something went wrong'); return; }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setOpen(false);
    // Reset after close animation
    setTimeout(() => { setDone(false); setError(null); setDescription(''); setType('WRONG_INFO'); }, 300);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-bark-300 hover:text-bark-500 transition-colors"
      >
        <Flag className="w-3 h-3" />
        Report an issue
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-bark-900/40 backdrop-blur-sm" onClick={close} />

          <div className="relative z-10 w-full max-w-md bg-white dark:bg-bark-800 rounded-2xl shadow-camp-hover overflow-hidden animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-cream-200 dark:border-bark-600">
              <h2 className="font-display font-bold text-bark-700 dark:text-cream-100">Report an issue</h2>
              <button onClick={close} className="p-1.5 rounded-xl hover:bg-cream-100 dark:hover:bg-bark-700 text-bark-400 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {done ? (
              <div className="px-5 py-10 text-center">
                <CheckCircle className="w-10 h-10 text-pine-500 mx-auto mb-3" />
                <p className="font-semibold text-bark-700 dark:text-cream-100">Thanks for the report!</p>
                <p className="text-sm text-bark-400 mt-1">We'll review it and update the listing.</p>
                <button onClick={close} className="mt-5 btn-secondary text-sm">Close</button>
              </div>
            ) : (
              <div className="px-5 py-5 space-y-4">
                {/* Type selector */}
                <div>
                  <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">What's wrong?</label>
                  <div className="space-y-1.5">
                    {REPORT_TYPES.map(rt => (
                      <button
                        key={rt.value}
                        onClick={() => setType(rt.value)}
                        className={cn(
                          'w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all',
                          type === rt.value
                            ? 'border-pine-400 bg-pine-50 dark:bg-pine-900/20'
                            : 'border-cream-200 dark:border-bark-600 hover:border-cream-300 dark:hover:border-bark-500'
                        )}
                      >
                        <div className={cn(
                          'w-4 h-4 rounded-full border-2 mt-0.5 shrink-0 transition-colors',
                          type === rt.value ? 'border-pine-500 bg-pine-500' : 'border-bark-300'
                        )} />
                        <div>
                          <p className={cn('text-sm font-medium', type === rt.value ? 'text-pine-700 dark:text-pine-400' : 'text-bark-600 dark:text-cream-300')}>{rt.label}</p>
                          <p className="text-xs text-bark-300 mt-0.5">{rt.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="text-xs font-semibold text-bark-400 uppercase tracking-wide mb-2 block">Details</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Tell us what's incorrect or missing…"
                    rows={3}
                    maxLength={2000}
                    className="w-full text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-pine-400 resize-none"
                  />
                  {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-1">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-xs text-bark-300">Reports are reviewed by our team.</p>
                    {description.trim().length > 0 && description.trim().length < 5 && (
                      <p className="text-xs text-bark-400">{5 - description.trim().length} more chars needed</p>
                    )}
                  </div>
                  <button
                    onClick={submit}
                    disabled={submitting || description.trim().length < 5}
                    className="btn-primary text-sm gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flag className="w-3.5 h-3.5" />}
                    Submit
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
