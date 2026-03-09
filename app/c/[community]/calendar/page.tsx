import type { Metadata } from "next";
import { getAllCamps } from "@/lib/camp-repository";
import { CalendarExplorer } from "@/components/calendar-explorer";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: { community: string };
}): Promise<Metadata> {
  const displayName =
    params.community.charAt(0).toUpperCase() + params.community.slice(1);

  return {
    title: `${displayName} Camp Calendar | CampFit`,
    description: `Browse kids' summer camp availability by week in ${displayName}. Find open spots that match your schedule.`,
  };
}

export default async function CommunityCalendarPage({
  params,
}: {
  params: { community: string };
}) {
  const camps = await getAllCamps(params.community);
  // Calendar only shows summer camps (they have week-by-week schedules)
  const summerCamps = camps.filter((c) => c.campType === "SUMMER_DAY");

  return <CalendarExplorer camps={summerCamps} />;
}
