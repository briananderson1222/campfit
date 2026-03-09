"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, ClipboardList, History, Database,
  ExternalLink, Menu, X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AdminSidebarProps {
  userEmail: string;
  pendingCount: number;
}

export function AdminSidebar({ userEmail, pendingCount }: AdminSidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const navLinks = [
    { href: "/admin", icon: <LayoutDashboard className="w-4 h-4" />, label: "Dashboard", exact: true },
    { href: "/admin/review", icon: <ClipboardList className="w-4 h-4" />, label: "Review Queue", badge: pendingCount },
    { href: "/admin/crawls", icon: <History className="w-4 h-4" />, label: "Crawl History" },
    { href: "/admin/camps", icon: <Database className="w-4 h-4" />, label: "Camp Data" },
  ];

  const isActive = (href: string, exact = false) =>
    exact ? pathname === href : pathname.startsWith(href);

  const SidebarContent = () => (
    <>
      <div className="px-4 py-5 border-b border-pine-600 flex items-center justify-between">
        <div>
          <Link href="/admin" onClick={() => setOpen(false)} className="font-display font-bold text-lg text-cream-100 tracking-tight">
            Camp<span className="text-terracotta-400">Fit</span>{" "}
            <span className="text-pine-300 font-normal text-sm">Admin</span>
          </Link>
          <p className="text-xs text-pine-400 mt-0.5 truncate max-w-[160px]">{userEmail}</p>
        </div>
        <button
          className="sm:hidden p-1.5 rounded-lg hover:bg-pine-600 text-pine-300"
          onClick={() => setOpen(false)}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav className="flex-1 px-2 py-4 space-y-1">
        {navLinks.map(({ href, icon, label, exact, badge }) => (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
              isActive(href, exact)
                ? "bg-pine-600 text-cream-100 font-medium"
                : "text-pine-200 hover:bg-pine-600 hover:text-cream-100"
            )}
          >
            {icon}
            {label}
            {badge != null && badge > 0 && (
              <span className="ml-auto bg-terracotta-400 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-5 text-center">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </Link>
        ))}
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
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="sm:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-4 h-14 bg-pine-700 border-b border-pine-600">
        <Link href="/admin" className="font-display font-bold text-cream-100">
          Camp<span className="text-terracotta-400">Fit</span>{" "}
          <span className="text-pine-300 font-normal text-sm">Admin</span>
        </Link>
        <button
          onClick={() => setOpen(true)}
          className="p-2 rounded-lg hover:bg-pine-600 text-pine-200"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Mobile overlay */}
      {open && (
        <div
          className="sm:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "sm:hidden fixed top-0 left-0 z-50 h-full w-64 bg-pine-700 text-pine-100 flex flex-col transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden sm:flex w-56 shrink-0 bg-pine-700 text-pine-100 flex-col">
        <SidebarContent />
      </aside>
    </>
  );
}
