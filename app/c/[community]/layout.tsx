import { notFound } from "next/navigation";
import { getDistinctCommunities } from "@/lib/camp-repository";
import { CommunityProvider } from "@/lib/community-context";

export const dynamic = "force-dynamic";

export default async function CommunityLayout(
  props: {
    children: React.ReactNode;
    params: Promise<{ community: string }>;
  }
) {
  const params = await props.params;

  const {
    children
  } = props;

  const communities = await getDistinctCommunities();
  const community = communities.find((c) => c.communitySlug === params.community);
  if (!community) notFound();

  return (
    <CommunityProvider slug={community.communitySlug} displayName={community.displayName}>
      {children}
    </CommunityProvider>
  );
}
