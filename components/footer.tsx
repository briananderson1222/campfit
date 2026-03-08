import Link from "next/link";
import { Compass, Heart } from "lucide-react";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-cream-400/40 bg-pine-600 text-pine-100">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12 sm:py-16">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-10 sm:gap-8">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-lg bg-cream-100/15 flex items-center justify-center">
                <Compass className="w-4 h-4 text-cream-100" />
              </div>
              <span className="font-display font-bold text-lg text-cream-100 tracking-tight">
                Camp<span className="text-terracotta-400">Scout</span>
              </span>
            </div>
            <p className="text-sm text-pine-200/70 leading-relaxed max-w-xs">
              Helping Denver parents discover the best camps for their kids.
              Summer, winter, sleepaway, and everything in between.
            </p>
          </div>

          {/* Links */}
          <div>
            <h3 className="font-display font-semibold text-cream-100 mb-4">
              Explore
            </h3>
            <div className="flex flex-col gap-2.5">
              <FooterLink href="/">Browse Camps</FooterLink>
              <FooterLink href="/calendar">Weekly Calendar</FooterLink>
              <FooterLink href="/dashboard">Saved Camps</FooterLink>
            </div>
          </div>

          {/* Info */}
          <div>
            <h3 className="font-display font-semibold text-cream-100 mb-4">
              Company
            </h3>
            <div className="flex flex-col gap-2.5">
              <FooterLink href="#">About CampScout</FooterLink>
              <FooterLink href="#">List Your Camp</FooterLink>
              <FooterLink href="#">Privacy Policy</FooterLink>
            </div>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-pine-500/40 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-pine-200/50">
          <p>2026 CampScout. Built in Denver, CO.</p>
          <p className="flex items-center gap-1">
            Made with <Heart className="w-3 h-3 text-terracotta-400 fill-terracotta-400" /> for Colorado families
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="text-sm text-pine-200/70 hover:text-cream-100 transition-colors duration-200"
    >
      {children}
    </Link>
  );
}
