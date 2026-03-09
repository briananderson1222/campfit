import { notFound } from "next/navigation";
import { getDistinctCommunities } from "@/lib/camp-repository";
import { CommunityProvider } from "@/lib/community-context";

export default async function CommunityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { community: string };
}) {
  const communities = await getDistinctCommunities();
  const community = communities.find((c) => c.communitySlug === params.community);
  if (!community) notFound();

  return (
    <CommunityProvider slug={community.communitySlug} displayName={community.displayName}>
      {children}
    </CommunityProvider>
  );
}
