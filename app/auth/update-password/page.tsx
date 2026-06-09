"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle, Compass, Lock, TreePine } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function UpdatePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -right-20 w-72 h-72 bg-pine-200/20 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -left-20 w-72 h-72 bg-amber-300/15 rounded-full blur-3xl" />
        <TreePine className="absolute bottom-8 right-8 w-24 h-24 text-pine-600/[0.04]" />
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
            Choose a new password
          </h1>
          <p className="auth-muted text-sm mt-1">
            Use at least 8 characters
          </p>
        </div>

        <div className="auth-card p-6 sm:p-8">
          {success ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-pine-100 flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="w-7 h-7 text-pine-500" />
              </div>
              <h2 className="font-display text-xl font-extrabold auth-title mb-2">
                Password updated
              </h2>
              <p className="auth-muted text-sm mb-6">
                Your new password is ready to use.
              </p>
              <Link href="/dashboard" className="btn-primary">
                Go to Dashboard
              </Link>
            </div>
          ) : (
            <form onSubmit={handleUpdate} className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold auth-label uppercase tracking-wider mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 auth-muted" />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="8+ characters"
                    minLength={8}
                    required
                    className="input-field pl-10"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold auth-label uppercase tracking-wider mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 auth-muted" />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Repeat password"
                    minLength={8}
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
                  "Update Password"
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
