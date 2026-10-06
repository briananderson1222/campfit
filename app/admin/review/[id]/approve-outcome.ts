/**
 * What the review page does with a successful approve response. The values
 * and their review evidence were committed together; a step after that
 * (cache refresh, change log, metrics, session revocation) can still fail and
 * comes back in `provenanceErrors`. The page then stays and says so instead
 * of moving on as if everything landed.
 */
export function approveOutcome(body: { provenanceErrors?: { step: string; message: string }[] } | null | undefined): {
  stay: boolean;
  message: string | null;
  /** Sessions whose stored time was deliberately kept (not a failure): one sentence each, naming the session. */
  kept: string[];
} {
  const all = body?.provenanceErrors ?? [];
  const kept = all.filter((entry) => entry.step === 'sessionTimeKept').map((entry) => entry.message);
  const errors = all.filter((entry) => entry.step !== 'sessionTimeKept');
  if (errors.length === 0) return { stay: kept.length > 0, message: null, kept };
  return {
    stay: true,
    message: `Applied, but a follow-up step failed (${errors.map((error) => error.step).join(', ')}): ${errors.map((error) => error.message.slice(0, 300)).join(' / ')}. The camp's verification status or history may be out of date until the next change.`,
    kept,
  };
}
