"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export function AdsenseLoader() {
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        inject();
        return;
      }
      fetch("/api/me")
        .then((r) => r.json())
        .then((d) => {
          if (!d.isPremium) inject();
        })
        .catch(() => inject()); // on error, default to showing ads
    });
  }, []);

  return null;
}

function inject() {
  if (document.getElementById("campfit-adsense-loader")) return; // already loaded
  const s = document.createElement("script");
  s.id = "campfit-adsense-loader";
  s.src =
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8332505769102683";
  s.async = true;
  s.crossOrigin = "anonymous";
  document.head.appendChild(s);
}
