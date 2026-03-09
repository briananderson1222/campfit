"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";

const MAX_COMPARE = 3;
const STORAGE_KEY = "campscout_compare";

interface CompareContextValue {
  compareList: string[]; // slugs
  isComparing: (slug: string) => boolean;
  toggleCompare: (slug: string) => void;
  clearCompare: () => void;
}

const CompareContext = createContext<CompareContextValue>({
  compareList: [],
  isComparing: () => false,
  toggleCompare: () => {},
  clearCompare: () => {},
});

export function CompareProvider({ children }: { children: ReactNode }) {
  const [compareList, setCompareList] = useState<string[]>([]);

  // Load from sessionStorage on mount
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) setCompareList(JSON.parse(stored));
    } catch {}
  }, []);

  // Persist on change
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(compareList));
    } catch {}
  }, [compareList]);

  const isComparing = useCallback(
    (slug: string) => compareList.includes(slug),
    [compareList]
  );

  const toggleCompare = useCallback((slug: string) => {
    setCompareList((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      if (prev.length >= MAX_COMPARE) return prev; // at max
      return [...prev, slug];
    });
  }, []);

  const clearCompare = useCallback(() => setCompareList([]), []);

  return (
    <CompareContext.Provider
      value={{ compareList, isComparing, toggleCompare, clearCompare }}
    >
      {children}
    </CompareContext.Provider>
  );
}

export function useCompare() {
  return useContext(CompareContext);
}
