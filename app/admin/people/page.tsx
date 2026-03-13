import Link from 'next/link';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export const dynamic = 'force-dynamic';

async function getPeople() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p."fullName",
      p.slug,
      COUNT(DISTINCT cpr.id)::int AS "campRoles",
      COUNT(DISTINCT ppr.id)::int AS "providerRoles",
      COUNT(DISTINCT pcm.id)::int AS "contactCount"
    FROM "Person" p
    LEFT JOIN "CampPersonRole" cpr ON cpr."personId" = p.id
    LEFT JOIN "ProviderPersonRole" ppr ON ppr."personId" = p.id
    LEFT JOIN "PersonContactMethod" pcm ON pcm."personId" = p.id
    GROUP BY p.id
    ORDER BY p."fullName" ASC
  `);
  return rows;
}

export default async function AdminPeoplePage() {
  const auth = await requireAdminAccess();
  if ('error' in auth) return null;
  const people = await getPeople().catch(() => []);

  return (
    <div>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-extrabold text-bark-700">People</h1>
        <p className="text-bark-400 text-sm mt-1">
          {people.length} shared people record{people.length !== 1 ? 's' : ''} across camps and providers
        </p>
      </div>

      <div className="glass-panel overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-300/60 text-xs text-bark-300 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-semibold">Name</th>
              <th className="text-center px-4 py-3 font-semibold">Camp Roles</th>
              <th className="text-center px-4 py-3 font-semibold">Provider Roles</th>
              <th className="text-center px-4 py-3 font-semibold">Contacts</th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-bark-300">No people yet</td>
              </tr>
            ) : people.map((person: any, index: number) => (
              <tr
                key={person.id}
                className={index % 2 === 0 ? 'bg-white/20 border-b border-cream-200/50' : 'bg-cream-50/30 border-b border-cream-200/50'}
              >
                <td className="px-4 py-3">
                  <Link href={`/admin/people/${person.id}`} className="font-medium text-bark-700 hover:text-pine-600">{person.fullName}</Link>
                  <div className="text-xs text-bark-300">{person.slug}</div>
                </td>
                <td className="px-4 py-3 text-center text-bark-500">{person.campRoles}</td>
                <td className="px-4 py-3 text-center text-bark-500">{person.providerRoles}</td>
                <td className="px-4 py-3 text-center text-bark-500">{person.contactCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-bark-300 mt-4">
        People are currently created from camp/provider admin panels. Dedicated person detail pages can be added on top of this shared graph.
      </p>
    </div>
  );
}
