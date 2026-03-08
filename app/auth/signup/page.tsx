"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Compass, Mail, Lock, User, CheckCircle, AlertCircle, TreePine } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setSuccess(true);
    }
  };

  const handleGoogleSignup = async () => {
    setGoogleLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm text-center animate-fade-up">
          <div className="w-16 h-16 rounded-full bg-pine-100 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-pine-500" />
          </div>
          <h2 className="font-display text-2xl font-extrabold text-bark-700 mb-2">
            Check your email
          </h2>
          <p className="text-bark-400 text-sm mb-6">
            We sent a confirmation link to <strong className="text-bark-600">{email}</strong>.
            Click it to activate your account.
          </p>
          <Link href="/auth/login" className="btn-secondary">
            Back to Sign In
          </Link>
        </div>
      </div>
    );
  }

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
            <span className="font-display font-bold text-2xl text-bark-700 tracking-tight">
              Camp<span className="text-terracotta-400">Scout</span>
            </span>
          </Link>
          <h1 className="font-display text-2xl font-extrabold text-bark-700 mt-2">
            Create an account
          </h1>
          <p className="text-bark-400 text-sm mt-1">
            Save camps, get registration alerts
          </p>
        </div>

        <div className="glass-panel p-6 sm:p-8">
          <button
            onClick={handleGoogleSignup}
            disabled={googleLoading}
            className={cn(
              "w-full flex items-center justify-center gap-3 px-4 py-3 rounded-2xl",
              "border-2 border-cream-400/60 bg-white hover:bg-cream-50",
              "text-bark-600 font-medium text-sm transition-all duration-200",
              "hover:border-bark-300 hover:shadow-sm active:scale-[0.99]",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {googleLoading ? (
              <div className="w-5 h-5 border-2 border-bark-300 border-t-bark-600 rounded-full animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
            )}
            Continue with Google
          </button>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-cream-400/60" />
            <span className="text-xs text-bark-300 font-medium">or</span>
            <div className="flex-1 h-px bg-cream-400/60" />
          </div>

          <form onSubmit={handleSignup} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-bark-500 uppercase tracking-wider mb-1.5">
                Your Name
              </label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-bark-300" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex Smith"
                  required
                  className="input-field pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-bark-500 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-bark-300" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="input-field pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-bark-500 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-bark-300" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8+ characters"
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
                "Create Account"
              )}
            </button>

            <p className="text-xs text-bark-300 text-center">
              By signing up you agree to our{" "}
              <span className="text-pine-500">Terms</span> &{" "}
              <span className="text-pine-500">Privacy Policy</span>
            </p>
          </form>
        </div>

        <p className="text-center text-sm text-bark-400 mt-6">
          Already have an account?{" "}
          <Link href="/auth/login" className="text-pine-500 font-medium hover:text-pine-600">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
