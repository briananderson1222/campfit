"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, CheckCircle, Compass, Mail, Send, TreePine } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleReset = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/update-password`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-20 w-72 h-72 bg-pine-200/20 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-20 w-72 h-72 bg-amber-300/15 rounded-full blur-3xl" />
        <TreePine className="absolute bottom-8 left-8 w-24 h-24 text-pine-600/[0.04]" />
      </div>

      <div className="relative w-full max-w-sm animate-fade-up">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2.5 group mb-4">
            <div className="w-10 h-10 rounded-xl bg-pine-600 flex items-center justify-center shadow-sm">
              <Compass className="w-5 h-5 text-cream-100" strokeWidth={2.5} />
            </div>
            <span className="font-display font-bold text-2xl auth-title tracking-tight">
              Camp<span className="text-terracotta-400">Fit</span>
            </span>
          </Link>
          <h1 className="font-display text-2xl font-extrabold auth-title mt-2">
            Reset your password
          </h1>
          <p className="auth-muted text-sm mt-1">
            We&apos;ll send a reset link to your email
          </p>
        </div>

        <div className="auth-card p-6 sm:p-8">
          {sent ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-pine-100 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-7 h-7 text-pine-500" />
              </div>
              <h2 className="font-display text-xl font-extrabold auth-title mb-2">
                Check your email
              </h2>
              <p className="auth-muted text-sm mb-6">
                If an account exists for <strong className="auth-text">{email}</strong>, a password reset link is on the way.
              </p>
              <Link href="/auth/login" className="btn-secondary">
                Back to Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold auth-label uppercase tracking-wider mb-1.5">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 auth-muted" />
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    required
                    className="input-field pl-10"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full py-3 text-base disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Send Reset Link
                  </>
                )}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm auth-muted mt-6">
          <Link href="/auth/login" className="inline-flex items-center gap-1.5 auth-link font-medium">
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
