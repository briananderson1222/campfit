"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Compass,
  CalendarDays,
  Heart,
  GitCompareArrows,
  Menu,
  X,
  LogIn,
  LogOut,
  User,
  LayoutDashboard,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useCommunity } from "@/lib/community-context";
import { routes } from "@/lib/routes";
import { LangToggle } from "@/components/lang-toggle";
import type { User as SupabaseUser } from "@supabase/supabase-js";

function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        className={cn(
          "p-2 rounded-xl transition-colors",
          "hover:bg-cream-200/60 dark:hover:bg-bark-600/60",
          className
        )}
        aria-label="Toggle theme"
      >
        <span className="w-4 h-4 block" />
      </button>
    );
  }

  // cycle: light → dark → system
  function cycleTheme() {
    if (theme === "light") setTheme("dark");
    else if (theme === "dark") setTheme("system");
    else setTheme("light");
  }

  const label =
    theme === "light"
      ? "Switch to dark mode"
      : theme === "dark"
      ? "Switch to system theme"
      : "Switch to light mode";

  const Icon =
    theme === "system"
      ? Monitor
      : resolvedTheme === "dark"
      ? Moon
      : Sun;

  return (
    <button
      onClick={cycleTheme}
      className={cn(
        "p-2 rounded-xl transition-colors",
        "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60",
        "dark:text-cream-300 dark:hover:text-cream-100 dark:hover:bg-bark-600/60",
        className
      )}
      aria-label={label}
      title={label}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

export function Nav() {
  const router = useRouter();
  const { slug: communitySlug } = useCommunity();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user);
      if (user) fetch('/api/me').then(r => r.json()).then(d => setIsAdmin(d.isAdmin === true));
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_, session) => {
        setUser(session?.user ?? null);
        if (session?.user) fetch('/api/me').then(r => r.json()).then(d => setIsAdmin(d.isAdmin === true));
        else setIsAdmin(false);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUserMenuOpen(false);
    router.push("/");
    router.refresh();
  };

  const userInitial = user?.user_metadata?.name?.[0]?.toUpperCase()
    ?? user?.email?.[0]?.toUpperCase()
    ?? "U";

  return (
    <nav className="sticky top-0 z-50 glass-panel border-b border-cream-400/30 dark:border-bark-600/30 px-4 sm:px-6">
      <div className="mx-auto max-w-7xl flex items-center justify-between h-16">
        {/* Logo */}
        <Link href={routes.home()} className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl bg-pine-600 flex items-center justify-center shadow-sm group-hover:shadow-md transition-shadow">
            <Compass className="w-5 h-5 text-cream-100" strokeWidth={2.5} />
          </div>
          <span className="font-display font-bold text-xl text-bark-700 dark:text-cream-100 tracking-tight">
            Camp<span className="text-terracotta-400">Fit</span>
          </span>
        </Link>

        {/* Desktop links */}
        <div className="hidden sm:flex items-center gap-1">
          <NavLink href={routes.community(communitySlug)} icon={<Compass className="w-4 h-4" />}>
            Explore
          </NavLink>
          <NavLink href={routes.communityCalendar(communitySlug)} icon={<CalendarDays className="w-4 h-4" />}>
            Calendar
          </NavLink>
          <NavLink href={routes.communityCompare(communitySlug)} icon={<GitCompareArrows className="w-4 h-4" />}>
            Compare
          </NavLink>
          <NavLink href="/dashboard" icon={<Heart className="w-4 h-4" />}>
            Saved
          </NavLink>
          <div className="w-px h-6 bg-cream-400/60 mx-2" />
          <ThemeToggle />
          <LangToggle />

          {user ? (
            <div className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-cream-200/60 dark:hover:bg-bark-600/60 transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-pine-600 flex items-center justify-center text-cream-100 text-sm font-bold">
                  {userInitial}
                </div>
              </button>

              {userMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setUserMenuOpen(false)}
                  />
                  <div className="absolute right-0 mt-2 w-48 glass-panel border border-cream-400/40 dark:border-bark-600/40 shadow-camp-hover rounded-2xl overflow-hidden z-20 animate-fade-in">
                    <div className="px-4 py-3 border-b border-cream-400/40 dark:border-bark-600/40">
                      <p className="text-xs text-bark-300 dark:text-bark-400">Signed in as</p>
                      <p className="text-sm font-medium text-bark-600 dark:text-cream-200 truncate">
                        {user.email}
                      </p>
                    </div>
                    <Link
                      href="/dashboard"
                      onClick={() => setUserMenuOpen(false)}
                      className="flex items-center gap-2 px-4 py-2.5 text-sm text-bark-500 dark:text-cream-300 hover:bg-cream-200/60 dark:hover:bg-bark-600/60 transition-colors"
                    >
                      <User className="w-4 h-4" />
                      My Dashboard
                    </Link>
                    {isAdmin && (
                      <Link
                        href="/admin"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-4 py-2.5 text-sm text-pine-600 dark:text-pine-300 font-medium hover:bg-pine-50 dark:hover:bg-pine-900/40 transition-colors"
                      >
                        <LayoutDashboard className="w-4 h-4" />
                        Admin Portal
                      </Link>
                    )}
                    <button
                      onClick={handleSignOut}
                      className="flex items-center gap-2 px-4 py-2.5 text-sm text-bark-500 dark:text-cream-300 hover:bg-cream-200/60 dark:hover:bg-bark-600/60 transition-colors w-full text-left"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link href="/auth/login" className="btn-primary text-sm px-4 py-2">
              <LogIn className="w-4 h-4" />
              Sign In
            </Link>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          className="sm:hidden p-2 rounded-xl hover:bg-cream-200 dark:hover:bg-bark-600/60 transition-colors"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? (
            <X className="w-5 h-5 text-bark-500 dark:text-cream-300" />
          ) : (
            <Menu className="w-5 h-5 text-bark-500 dark:text-cream-300" />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="sm:hidden pb-4 border-t border-cream-400/30 dark:border-bark-600/30 mt-1 pt-3 animate-fade-in">
          <div className="flex flex-col gap-1">
            <MobileNavLink
              href={routes.community(communitySlug)}
              icon={<Compass className="w-5 h-5" />}
              onClick={() => setMobileOpen(false)}
            >
              Explore Camps
            </MobileNavLink>
            <MobileNavLink
              href={routes.communityCalendar(communitySlug)}
              icon={<CalendarDays className="w-5 h-5" />}
              onClick={() => setMobileOpen(false)}
            >
              Weekly Calendar
            </MobileNavLink>
            <MobileNavLink
              href={routes.communityCompare(communitySlug)}
              icon={<GitCompareArrows className="w-5 h-5" />}
              onClick={() => setMobileOpen(false)}
            >
              Compare Camps
            </MobileNavLink>
            <MobileNavLink
              href="/dashboard"
              icon={<Heart className="w-5 h-5" />}
              onClick={() => setMobileOpen(false)}
            >
              Saved Camps
            </MobileNavLink>
            <div className="mt-2 px-2 space-y-2">
              <div className="flex items-center justify-between px-1 py-1">
                <span className="text-sm text-bark-400 dark:text-cream-400 font-medium">Theme</span>
                <div className="flex items-center gap-2">
                  <LangToggle />
                  <ThemeToggle />
                </div>
              </div>
              {isAdmin && (
                <Link
                  href="/admin"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 px-3 py-3 rounded-xl text-pine-600 dark:text-pine-300 bg-pine-50 dark:bg-pine-900/40 font-medium transition-colors"
                >
                  <LayoutDashboard className="w-5 h-5" />
                  Admin Portal
                </Link>
              )}
              {user ? (
                <button
                  onClick={() => {
                    setMobileOpen(false);
                    handleSignOut();
                  }}
                  className="btn-secondary w-full text-sm"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out ({user.email})
                </button>
              ) : (
                <Link
                  href="/auth/login"
                  onClick={() => setMobileOpen(false)}
                  className="btn-primary w-full text-sm flex items-center justify-center gap-2"
                >
                  <LogIn className="w-4 h-4" />
                  Sign In
                </Link>
              )}
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
        "text-bark-400 hover:text-bark-600 hover:bg-cream-200/60",
        "dark:text-cream-400 dark:hover:text-cream-200 dark:hover:bg-bark-600/60",
        "transition-all duration-200"
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
      className="flex items-center gap-3 px-3 py-3 rounded-xl text-bark-500 dark:text-cream-300 hover:bg-cream-200/60 dark:hover:bg-bark-600/60 font-medium transition-colors"
    >
      {icon}
      {children}
    </Link>
  );
}
