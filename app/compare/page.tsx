import { Suspense } from "react";
import { getCampBySlug } from "@/lib/camp-repository";
import { CompareClient } from "@/components/compare-client";

export const revalidate = 3600;

export const metadata = {
  title: "Compare Camps — CampScout",
  description:
    "Compare up to 3 Denver kids camps side by side — pricing, schedules, age groups, and more.",
};

export default async function ComparePage({
  searchParams,
}: {
  searchParams: { camps?: string };
}) {
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
