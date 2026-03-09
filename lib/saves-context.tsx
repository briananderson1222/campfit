"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

interface SavesContextValue {
  savedIds: Set<string>;
  toggle: (campId: string) => Promise<void>;
  isSaved: (campId: string) => boolean;
}

const SavesContext = createContext<SavesContextValue>({
  savedIds: new Set(),
  toggle: async () => {},
  isSaved: () => false,
});

export function SavesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/saves")
      .then((r) => r.json())
      .then(({ savedIds: ids }) => {
        if (Array.isArray(ids)) setSavedIds(new Set(ids));
      })
      .catch(() => {});
  }, []);

  const toggle = useCallback(async (campId: string) => {
    const already = savedIds.has(campId);

    if (already) {
      // Optimistic remove
      setSavedIds((prev) => { const s = new Set(prev); s.delete(campId); return s; });
      const res = await fetch(`/api/saves?campId=${campId}`, { method: "DELETE" });
      if (!res.ok) {
        // Revert
        setSavedIds((prev) => new Set(prev).add(campId));
      }
    } else {
      // Optimistic add
      setSavedIds((prev) => new Set(prev).add(campId));
      const res = await fetch("/api/saves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campId }),
      });
      if (res.status === 401) {
        // Not logged in — revert and redirect
        setSavedIds((prev) => { const s = new Set(prev); s.delete(campId); return s; });
        router.push("/auth/login");
        return;
      }
      if (!res.ok) {
        setSavedIds((prev) => { const s = new Set(prev); s.delete(campId); return s; });
      }
    }
  }, [savedIds, router]);

  return (
    <SavesContext.Provider value={{ savedIds, toggle, isSaved: (id) => savedIds.has(id) }}>
      {children}
    </SavesContext.Provider>
  );
}

export const useSaves = () => useContext(SavesContext);
