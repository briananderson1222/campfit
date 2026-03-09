"use client";
import { createContext, useContext, ReactNode } from "react";

interface CommunityContextValue {
  slug: string;
  displayName: string;
}

const CommunityContext = createContext<CommunityContextValue>({
  slug: "denver",
  displayName: "Denver",
});

export function CommunityProvider({
  slug,
  displayName,
  children,
}: CommunityContextValue & { children: ReactNode }) {
  return (
    <CommunityContext.Provider value={{ slug, displayName }}>
      {children}
    </CommunityContext.Provider>
  );
}

export function useCommunity() {
  return useContext(CommunityContext);
}
