import type { Metadata } from "next";
import { getAllCamps } from "@/lib/camp-repository";
import { CampExplorer } from "@/components/camp-explorer";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: { community: string };
}): Promise<Metadata> {
  // Capitalize first letter of community slug as a fallback display name
  const displayName =
    params.community.charAt(0).toUpperCase() + params.community.slice(1);

  return {
    title: `${displayName} Kids Camps | CampFit`,
    description: `Browse the best kids camps in ${displayName}. Filter by age, activity, and weekly availability.`,
  };
}

export default async function CommunityPage({
  params,
}: {
  params: { community: string };
}) {
  const camps = await getAllCamps(params.community);

  return <CampExplorer camps={camps} totalCount={camps.length} />;
}
