import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAdminAccess } from '@/lib/admin/access';
import { getProviders } from '@/lib/admin/provider-repository';
import { NewCampForm } from './camp-new-form';

export const dynamic = 'force-dynamic';

export default async function NewCampPage(
  props: {
    searchParams: Promise<{ providerId?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;

  // Admins see providers across every community (empty array = no scope
  // filter, matching `communityScopeSql`'s "no filter" semantics); moderators
  // see only their assigned communities. No hardcoded community — this must
  // stay in sync with `app/admin/camps/page.tsx`'s own community scoping.
  const providers = await getProviders(
    auth.access.isAdmin ? [] : auth.access.communities,
    'active',
  ).catch(() => []);

  return (
    <div className="space-y-6">
      <Link href="/admin/camps" className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500">
        <ArrowLeft className="h-4 w-4" />
        Back to camps
      </Link>

      <div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700">New Camp</h1>
        <p className="mt-1 text-sm text-bark-400">Create a camp linked to a provider, then crawl or edit it from the camp page.</p>
      </div>

      <NewCampForm
        providers={providers.map((provider) => ({ id: provider.id, name: provider.name }))}
        defaultProviderId={searchParams.providerId ?? ''}
      />
    </div>
  );
}
