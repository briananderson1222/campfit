import type { Metadata } from "next";
import { getAllCamps } from "@/lib/camp-repository";
import { CalendarExplorer } from "@/components/calendar-explorer";

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
    title: `${displayName} Camp Calendar | CampFit`,
    description: `Browse kids' summer camp availability by week in ${displayName}. Find open spots that match your schedule.`,
  };
}

export default async function CommunityCalendarPage(
  props: {
    params: Promise<{ community: string }>;
  }
) {
  const params = await props.params;
  const camps = await getAllCamps(params.community);
  // Calendar only shows summer camps (they have week-by-week schedules)
  const summerCamps = camps.filter((c) => c.campType === "SUMMER_DAY");

  return <CalendarExplorer camps={summerCamps} />;
}
