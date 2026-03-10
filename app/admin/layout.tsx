import { createClient } from '@/lib/supabase/server';
import { getPendingCount } from '@/lib/admin/review-repository';
import { AdminSidebar } from './admin-sidebar';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const pendingCount = await getPendingCount().catch(() => 0);

  return (
    <div className="min-h-screen flex bg-cream-100 dark:bg-[#0f1a14] dark:text-cream-200">
      <AdminSidebar userEmail={user?.email ?? ''} pendingCount={pendingCount} />

      {/* Main — offset for mobile top bar */}
      <main className="flex-1 overflow-auto pt-14 sm:pt-0 text-bark-700 dark:text-cream-200">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
