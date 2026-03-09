"use client";

import { useState } from "react";
import { Shield, ShieldOff, Crown, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  tier: "FREE" | "PREMIUM" | null;
  isAdmin: boolean | null;
  savedCount: number;
}

interface ConfirmModal {
  userId: string;
  email: string;
  action: "make_admin" | "remove_admin" | "upgrade" | "downgrade";
}

export function UsersTable({ initialUsers }: { initialUsers: UserRow[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [confirm, setConfirm] = useState<ConfirmModal | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const ACTION_CONFIG: Record<ConfirmModal["action"], {
    label: string; description: string; color: string;
  }> = {
    make_admin: {
      label: "Grant Admin Access",
      description: "This user will be able to access the admin portal and manage camps.",
      color: "text-amber-600",
    },
    remove_admin: {
      label: "Revoke Admin Access",
      description: "This user will no longer be able to access the admin portal.",
      color: "text-red-600",
    },
    upgrade: {
      label: "Upgrade to Premium",
      description: "This user will get Premium features without a Stripe subscription.",
      color: "text-pine-600",
    },
    downgrade: {
      label: "Downgrade to Free",
      description: "This user will lose Premium features.",
      color: "text-bark-500",
    },
  };

  async function applyAction(modal: ConfirmModal) {
    setLoading(modal.userId);
    setConfirm(null);

    const patch: Record<string, unknown> = {};
    if (modal.action === "make_admin") patch.isAdmin = true;
    if (modal.action === "remove_admin") patch.isAdmin = false;
    if (modal.action === "upgrade") patch.tier = "PREMIUM";
    if (modal.action === "downgrade") patch.tier = "FREE";

    try {
      const res = await fetch(`/api/admin/users/${modal.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());

      setUsers(prev => prev.map(u =>
        u.id === modal.userId ? { ...u, ...patch } : u
      ));
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(null);
    }
  }

  const fmt = (d: string | null) => d
    ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-cream-300">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-cream-200 border-b border-cream-300">
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">User</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">Joined</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">Last seen</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">Tier</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">Saves</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-bark-400 uppercase tracking-wide">Admin</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {users.map(u => (
              <tr key={u.id} className={cn("bg-white hover:bg-cream-50 transition-colors", loading === u.id && "opacity-50 pointer-events-none")}>
                <td className="px-4 py-3">
                  <div className="font-medium text-bark-700">{u.name ?? u.email.split("@")[0]}</div>
                  <div className="text-xs text-bark-400">{u.email}</div>
                </td>
                <td className="px-4 py-3 text-bark-500">{fmt(u.createdAt)}</td>
                <td className="px-4 py-3 text-bark-400">{fmt(u.lastSignInAt)}</td>
                <td className="px-4 py-3">
                  <span className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                    u.tier === "PREMIUM"
                      ? "bg-amber-50 text-amber-600 border border-amber-200"
                      : "bg-cream-200 text-bark-400 border border-cream-300"
                  )}>
                    {u.tier === "PREMIUM" && <Crown className="w-3 h-3" />}
                    {u.tier ?? "FREE"}
                  </span>
                </td>
                <td className="px-4 py-3 text-bark-500">{u.savedCount}</td>
                <td className="px-4 py-3">
                  {u.isAdmin
                    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-pine-600"><Shield className="w-3.5 h-3.5" /> Admin</span>
                    : <span className="text-xs text-bark-300">—</span>
                  }
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    {u.tier === "PREMIUM" ? (
                      <button
                        onClick={() => setConfirm({ userId: u.id, email: u.email, action: "downgrade" })}
                        className="text-xs text-bark-400 hover:text-red-500 transition-colors"
                      >
                        Downgrade
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirm({ userId: u.id, email: u.email, action: "upgrade" })}
                        className="text-xs text-pine-500 hover:text-pine-700 font-medium transition-colors"
                      >
                        Upgrade
                      </button>
                    )}
                    {u.isAdmin ? (
                      <button
                        onClick={() => setConfirm({ userId: u.id, email: u.email, action: "remove_admin" })}
                        className="text-xs text-bark-400 hover:text-red-500 transition-colors"
                      >
                        <ShieldOff className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirm({ userId: u.id, email: u.email, action: "make_admin" })}
                        className="text-xs text-bark-400 hover:text-amber-500 transition-colors"
                        title="Grant admin"
                      >
                        <UserIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="text-center py-12 text-bark-300">No users yet.</div>
        )}
      </div>

      {/* Confirmation modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className={cn("font-display font-bold text-lg mb-1", ACTION_CONFIG[confirm.action].color)}>
              {ACTION_CONFIG[confirm.action].label}
            </h3>
            <p className="text-sm text-bark-500 mb-1">{confirm.email}</p>
            <p className="text-sm text-bark-400 mb-6">{ACTION_CONFIG[confirm.action].description}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirm(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-cream-300 text-sm text-bark-500 hover:bg-cream-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => applyAction(confirm)}
                className="flex-1 px-4 py-2 rounded-lg bg-bark-700 text-white text-sm font-medium hover:bg-bark-800 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
