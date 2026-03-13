import Link from 'next/link';
import { getPool } from '@/lib/db';
import { cn } from '@/lib/utils';
import { requireAdminAccess } from '@/lib/admin/access';
import { AttestationActions } from '@/components/admin/attestation-actions';
import { ReviewFlagActions } from '@/components/admin/review-flag-actions';

export const dynamic = 'force-dynamic';

function entityHref(entityType: string, entityId: string) {
  if (entityType === 'CAMP') return `/admin/camps/${entityId}`;
  if (entityType === 'PROVIDER') return `/admin/providers/${entityId}`;
  if (entityType === 'PERSON') return `/admin/people/${entityId}`;
  return null;
}

async function getTrustDashboard() {
  const pool = getPool();
  const [flags, attestations, aiActions] = await Promise.all([
    pool.query(`SELECT * FROM "ReviewFlag" ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, "createdAt" DESC LIMIT 50`),
    pool.query(`SELECT * FROM "FieldAttestation" ORDER BY "createdAt" DESC LIMIT 50`),
    pool.query(`SELECT * FROM "AiActionLog" ORDER BY "createdAt" DESC LIMIT 50`),
  ]);
  return { flags: flags.rows, attestations: attestations.rows, aiActions: aiActions.rows };
}

export default async function AdminTrustPage() {
  const auth = await requireAdminAccess();
  if ('error' in auth) return null;
  const { flags, attestations, aiActions } = await getTrustDashboard().catch(() => ({ flags: [], attestations: [], aiActions: [] }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700">Trust Ops</h1>
        <p className="text-bark-400 text-sm mt-1">
          Review flags, attestations, and AI-assisted admin actions
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <section className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-700 mb-3">Open Flags</h2>
          <div className="space-y-2">
            {flags.length === 0 ? (
              <p className="text-sm text-bark-300">No flags yet.</p>
            ) : flags.map((flag: any) => (
              <div key={flag.id} className={cn(
                'rounded-lg border px-3 py-2 text-sm',
                flag.status === 'OPEN' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-cream-300 text-bark-500'
              )}>
                <div className="font-semibold flex items-center justify-between gap-2">
                  <span>{flag.entityType} · {flag.status}</span>
                  <div className="flex items-center gap-2">
                    {entityHref(flag.entityType, flag.entityId) && (
                      <Link href={entityHref(flag.entityType, flag.entityId)!} className="text-xs text-pine-600 hover:text-pine-700">
                        Open
                      </Link>
                    )}
                    <ReviewFlagActions flagId={flag.id} status={flag.status} />
                  </div>
                </div>
                <div>{flag.comment}</div>
                <div className="text-xs opacity-70 mt-1">{new Date(flag.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-700 mb-3">Recent Attestations</h2>
          <div className="space-y-2">
            {attestations.length === 0 ? (
              <p className="text-sm text-bark-300">No attestations yet.</p>
            ) : attestations.map((att: any) => (
              <div key={att.id} className="rounded-lg border border-pine-200 bg-pine-50 px-3 py-2 text-sm text-pine-900">
                <div className="font-semibold flex items-center justify-between gap-2">
                  <span>{att.entityType} · {att.fieldKey}</span>
                  <div className="flex items-center gap-2">
                    {entityHref(att.entityType, att.entityId) && (
                      <Link href={entityHref(att.entityType, att.entityId)!} className="text-xs text-pine-700 hover:text-pine-800">
                        Open
                      </Link>
                    )}
                    <AttestationActions attestationId={att.id} />
                  </div>
                </div>
                <div className="text-xs opacity-80">{att.status} · {att.approvedBy ?? 'unapproved'}</div>
                {att.invalidationReason && <div className="text-xs mt-1 text-red-700">{att.invalidationReason}</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-700 mb-3">AI Action Log</h2>
          <div className="space-y-2">
            {aiActions.length === 0 ? (
              <p className="text-sm text-bark-300">No AI actions yet.</p>
            ) : aiActions.map((action: any) => (
              <div key={action.id} className="rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-700">
                <div className="font-semibold flex items-center justify-between gap-2">
                  <span>{action.action}</span>
                  {action.entityType && action.entityId && entityHref(action.entityType, action.entityId) && (
                    <Link href={entityHref(action.entityType, action.entityId)!} className="text-xs text-pine-600 hover:text-pine-700">
                      Open
                    </Link>
                  )}
                </div>
                <div className="text-xs text-bark-400">{action.capability} · {action.status}</div>
                {(action.input || action.output || action.error) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-bark-400 hover:text-bark-600">Details</summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-bark-700 p-2 text-[11px] text-cream-100">
{JSON.stringify({ input: action.input, output: action.output, error: action.error }, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <p className="text-xs text-bark-300">
        Use camp and provider pages for direct trust operations. This screen is the cross-entity audit view.
      </p>
    </div>
  );
}
