import { getAllCamps } from "@/lib/camp-repository";
import { CampExplorer } from "@/components/camp-explorer";

export const revalidate = 3600; // re-fetch at most once per hour

export default async function HomePage() {
  const camps = await getAllCamps();

  return <CampExplorer camps={camps} totalCount={camps.length} />;
}
