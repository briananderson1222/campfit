"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Settings } from "lucide-react";

interface AdminCampBarProps {
  campId: string;
  campName: string;
}

export function AdminCampBar({ campId, campName }: AdminCampBarProps) {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.isAdmin === true) setIsAdmin(true);
      })
      .catch(() => {});
  }, []);

  if (!isAdmin) return null;

  return (
    <div className="bg-bark-700 text-cream-200 text-xs py-2 px-4 flex items-center justify-between mb-4 rounded-xl">
      <div className="flex items-center gap-2">
        <Settings className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">Admin:</span>
        <span className="text-cream-400 truncate max-w-xs">{campName}</span>
      </div>
      <Link
        href={`/admin/camps/${campId}`}
        className="ml-4 shrink-0 underline underline-offset-2 hover:text-cream-100 transition-colors"
      >
        Edit this camp
      </Link>
    </div>
  );
}
