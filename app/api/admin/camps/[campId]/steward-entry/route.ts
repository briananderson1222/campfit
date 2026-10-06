/**
 * POST /api/admin/camps/[campId]/steward-entry
 *
 * A steward enters a value the camp is missing (a session's start and end
 * time, or a single-value camp requirement). The entry is stored and recorded
 * as that steward's attestation of it, in one transaction
 * (lib/admin/steward-entry.ts).
 *
 * Body: { kind: 'session-time', scheduleId, startTime, endTime }
 *     | { kind: 'camp-field', field, value }
 * Returns the derived dataConfidence and the requirements still missing.
 */
import { NextResponse } from 'next/server';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { isTransientDatabaseError } from '@/lib/admin/review-apply';
import {
  parseStewardEntry,
  recordStewardEntry,
  StewardEntryNotFoundError,
  StewardEntryValidationError,
} from '@/lib/admin/steward-entry';
import { RepositoryConnectionError } from '@/lib/admin/repository-errors';

export async function POST(req: Request, props: { params: Promise<{ campId: string }> }) {
  const params = await props.params;
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const entry = parseStewardEntry(await req.json().catch(() => null));
    const result = await recordStewardEntry(params.campId, entry, auth.access.email);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof StewardEntryValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof StewardEntryNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    const cause = error instanceof RepositoryConnectionError ? error.cause : error;
    if (isTransientDatabaseError(cause)) {
      return NextResponse.json({ error: 'Nothing was saved: the database was busy. Try again.' }, { status: 503 });
    }
    console.error('[steward-entry] failed:', error);
    return NextResponse.json({ error: 'Nothing was saved: the entry could not be recorded.' }, { status: 500 });
  }
}
