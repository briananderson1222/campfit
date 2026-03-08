import { getAllCamps } from "@/lib/camp-repository";
import { CalendarExplorer } from "@/components/calendar-explorer";

export const revalidate = 3600;

export default async function CalendarPage() {
  const camps = await getAllCamps();
  // Calendar only shows summer camps (they have week-by-week schedules)
  const summerCamps = camps.filter((c) => c.campType === "SUMMER_DAY");

  return <CalendarExplorer camps={summerCamps} />;
}
