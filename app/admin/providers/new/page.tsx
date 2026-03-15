import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireAdminAccess } from '@/lib/admin/access';
import { NewProviderForm } from './provider-new-form';

export const dynamic = 'force-dynamic';

export default async function NewProviderPage() {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) return null;

  const communitySlug = auth.access.isAdmin
    ? (auth.access.communities[0] ?? 'denver')
    : (auth.access.communities[0] ?? 'denver');

  return (
    <div className="space-y-6">
      <Link href="/admin/providers" className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500">
        <ArrowLeft className="h-4 w-4" />
        Back to providers
      </Link>

      <div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700">New Provider</h1>
        <p className="mt-1 text-sm text-bark-400">Create a provider record, then use crawl/discovery from the provider page.</p>
      </div>

      <NewProviderForm defaultCommunitySlug={communitySlug} />
    </div>
  );
}
