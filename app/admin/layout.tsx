import { createClient } from '@/lib/supabase/server';
import { getPendingCount } from '@/lib/admin/review-repository';
import { getPendingProviderProposalCount } from '@/lib/admin/provider-repository';
import { AdminSidebar } from './admin-sidebar';
import './admin-dark.css';
import { requireAdminAccess } from '@/lib/admin/access';
import { redirect } from 'next/navigation';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAdminAccess({ allowModerator: true });
  if ('error' in auth) redirect('/auth/login');
  const scope = auth.access.isAdmin ? undefined : auth.access.communities;
  const [pendingCount, pendingProviderCount] = await Promise.all([
    getPendingCount(scope).catch(() => 0),
    getPendingProviderProposalCount(scope).catch(() => 0),
  ]);

  return (
    <div className="min-h-screen flex bg-cream-100 dark:bg-[#0f1a14] dark:text-cream-200">
      <AdminSidebar
        userEmail={auth.access.email}
        pendingCount={pendingCount}
        pendingProviderCount={pendingProviderCount}
        isAdmin={auth.access.isAdmin}
        moderatorCommunities={auth.access.communities}
      />

      {/* Main — offset for mobile top bar */}
      <main className="flex-1 overflow-auto pt-14 sm:pt-0 text-bark-700 dark:text-cream-200">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
