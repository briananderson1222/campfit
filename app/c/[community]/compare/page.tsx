import type { Metadata } from "next";
import { Suspense } from "react";
import { getCampBySlug } from "@/lib/camp-repository";
import { CompareClient } from "@/components/compare-client";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: {
    params: Promise<{ community: string }>;
  }
): Promise<Metadata> {
  const params = await props.params;
  const displayName =
    params.community.charAt(0).toUpperCase() + params.community.slice(1);

  return {
    title: `Compare Camps — ${displayName} | CampFit`,
    description: `Compare up to 3 ${displayName} kids camps side by side — pricing, schedules, age groups, and more.`,
  };
}

export default async function CommunityComparePage(
  props: {
    params: Promise<{ community: string }>;
    searchParams: Promise<{ camps?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const slugList = (searchParams.camps || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  const camps = await Promise.all(
    slugList.map((slug) => getCampBySlug(slug))
  );
  const validCamps = camps.filter(Boolean) as NonNullable<(typeof camps)[number]>[];

  return (
    <Suspense>
      <CompareClient initialCamps={validCamps} />
    </Suspense>
  );
}
