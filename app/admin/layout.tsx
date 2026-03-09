import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getPendingCount } from '@/lib/admin/review-repository';
import { LayoutDashboard, ClipboardList, History, Database, ExternalLink } from 'lucide-react';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const pendingCount = await getPendingCount().catch(() => 0);

  return (
    <div className="min-h-screen flex bg-cream-100">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-pine-700 text-pine-100 flex flex-col">
        <div className="px-4 py-5 border-b border-pine-600">
          <Link href="/admin" className="font-display font-bold text-lg text-cream-100 tracking-tight">
            Camp<span className="text-terracotta-400">Fit</span>{' '}
            <span className="text-pine-300 font-normal text-sm">Admin</span>
          </Link>
          <p className="text-xs text-pine-400 mt-0.5 truncate">{user?.email}</p>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-1">
          <AdminNavLink href="/admin" icon={<LayoutDashboard className="w-4 h-4" />} exact>
            Dashboard
          </AdminNavLink>
          <AdminNavLink href="/admin/review" icon={<ClipboardList className="w-4 h-4" />}>
            Review Queue
            {pendingCount > 0 && (
              <span className="ml-auto bg-terracotta-400 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-5 text-center">
                {pendingCount > 99 ? '99+' : pendingCount}
              </span>
            )}
          </AdminNavLink>
          <AdminNavLink href="/admin/crawls" icon={<History className="w-4 h-4" />}>
            Crawl History
          </AdminNavLink>
          <AdminNavLink href="/admin/camps" icon={<Database className="w-4 h-4" />}>
            Camp Data
          </AdminNavLink>
        </nav>

        <div className="px-3 py-4 border-t border-pine-600">
          <Link
            href="/"
            className="flex items-center gap-2 text-xs text-pine-400 hover:text-pine-200 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View site
          </Link>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}

function AdminNavLink({
  href, icon, children, exact = false
}: {
  href: string; icon: React.ReactNode; children: React.ReactNode; exact?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-pine-200 hover:bg-pine-600 hover:text-cream-100 transition-colors"
    >
      {icon}
      {children}
    </Link>
  );
}
