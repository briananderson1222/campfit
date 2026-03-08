"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Compass,
  CalendarDays,
  Heart,
  Menu,
  X,
  LogIn,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function Nav() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 glass-panel border-b border-cream-400/30 px-4 sm:px-6">
      <div className="mx-auto max-w-7xl flex items-center justify-between h-16">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2.5 group"
        >
          <div className="w-9 h-9 rounded-xl bg-pine-600 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
            <Compass className="w-5 h-5 text-cream-100" strokeWidth={2.5} />
          </div>
          <span className="font-display font-bold text-xl text-bark-700 tracking-tight">
            Camp<span className="text-terracotta-400">Scout</span>
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden sm:flex items-center gap-1">
          <NavLink href="/" icon={<Compass className="w-4 h-4" />}>
            Explore
          </NavLink>
          <NavLink href="/calendar" icon={<CalendarDays className="w-4 h-4" />}>
            Calendar
          </NavLink>
          <NavLink href="/dashboard" icon={<Heart className="w-4 h-4" />}>
            Saved
          </NavLink>
          <div className="w-px h-6 bg-cream-400/60 mx-2" />
          <button className="btn-primary text-sm px-4 py-2">
            <LogIn className="w-4 h-4" />
            Sign In
          </button>
        </div>

        {/* Mobile toggle */}
        <button
          className="sm:hidden p-2 rounded-xl hover:bg-cream-200 transition-colors"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? (
            <X className="w-5 h-5 text-bark-500" />
          ) : (
            <Menu className="w-5 h-5 text-bark-500" />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden pb-4 border-t border-cream-400/30 mt-1 pt-3 animate-fade-in">
          <div className="flex flex-col gap-1">
            <MobileNavLink href="/" icon={<Compass className="w-5 h-5" />} onClick={() => setMobileOpen(false)}>
              Explore Camps
            </MobileNavLink>
            <MobileNavLink href="/calendar" icon={<CalendarDays className="w-5 h-5" />} onClick={() => setMobileOpen(false)}>
              Weekly Calendar
            </MobileNavLink>
            <MobileNavLink href="/dashboard" icon={<Heart className="w-5 h-5" />} onClick={() => setMobileOpen(false)}>
              Saved Camps
            </MobileNavLink>
            <div className="mt-2 px-2">
              <button className="btn-primary w-full text-sm">
                <LogIn className="w-4 h-4" />
                Sign In
              </button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}

function NavLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium font-body",
        "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60 transition-all duration-200"
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

function MobileNavLink({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-3 px-3 py-3 rounded-xl text-bark-500 hover:bg-cream-200/60 font-medium transition-colors"
    >
      {icon}
      {children}
    </Link>
  );
}
