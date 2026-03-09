"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { translations, type Lang, type TranslationKey } from "./translations";

const COOKIE_NAME = "lang";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year in seconds

function getCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(name + "="));
  return match ? decodeURIComponent(match.split("=")[1]) : undefined;
}

function setCookie(name: string, value: string, maxAge: number) {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

function isValidLang(value: string | undefined): value is Lang {
  return value === "en" || value === "es";
}

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    // Check ?lang= query param first
    const params = new URLSearchParams(window.location.search);
    const queryLang = params.get(COOKIE_NAME);

    if (isValidLang(queryLang)) {
      setCookie(COOKIE_NAME, queryLang, COOKIE_MAX_AGE);
      setLangState(queryLang);
      return;
    }

    // Fall back to cookie
    const cookieLang = getCookie(COOKIE_NAME);
    if (isValidLang(cookieLang)) {
      setLangState(cookieLang);
    }
  }, []);

  const setLang = useCallback((newLang: Lang) => {
    setCookie(COOKIE_NAME, newLang, COOKIE_MAX_AGE);
    setLangState(newLang);
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[lang][key] ?? translations["en"][key] ?? key;
    },
    [lang]
  );

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    throw new Error("useLang must be used within a LangProvider");
  }
  return ctx;
}
