/**
 * What the review page does with a successful approve response. When part of
 * the record could not be written (`provenanceErrors`), the page stays and
 * says so instead of moving on as if everything landed. The affected fields
 * are applied but not verified (review-apply.ts withdraws them in the apply
 * transaction).
 */
export function approveOutcome(body: { provenanceErrors?: { step: string; message: string }[] } | null | undefined): { stay: boolean; message: string | null } {
  const errors = body?.provenanceErrors ?? [];
  if (errors.length === 0) return { stay: false, message: null };
  return {
    stay: true,
    message: `Applied, but part of the review record could not be written (${errors.map((error) => error.step).join(', ')}). Fields without their evidence are not verified. ${errors[0]!.message.slice(0, 300)}`,
  };
}
