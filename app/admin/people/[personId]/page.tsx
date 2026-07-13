import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireAdminAccess } from '@/lib/admin/access';
import { PersonEditor } from './person-editor';
import { PersonRoleActions } from './person-role-actions';
import { getPersonFieldTimeline } from '@/lib/admin/field-metadata';
import { getAdminPersonDetail } from '@/lib/admin/person-repository';

export const dynamic = 'force-dynamic';

export default async function AdminPersonDetailPage(props: { params: Promise<{ personId: string }> }) {
  const params = await props.params;
  const auth = await requireAdminAccess();
  if ('error' in auth) return null;

  const detail = await getAdminPersonDetail(params.personId).catch(() => null);
  if (!detail) notFound();
  const fieldTimeline = await getPersonFieldTimeline(params.personId).catch(() => ({}));

  return (
    <div className="space-y-6">
      <Link href="/admin/people" className="inline-flex items-center gap-1.5 text-sm text-bark-300 hover:text-pine-500">
        <ArrowLeft className="w-4 h-4" />
        Back to people
      </Link>

      <div>
        <h1 className="font-display text-3xl font-extrabold text-bark-700">{detail.person.fullName}</h1>
        <p className="text-bark-400 text-sm mt-1">{detail.contacts.length} contact method{detail.contacts.length !== 1 ? 's' : ''} · {detail.campRoles.length + detail.providerRoles.length} linked roles</p>
      </div>

      <PersonEditor
        person={{ ...detail.person, fieldTimeline }}
        contacts={detail.contacts}
        campRoles={detail.campRoles}
        providerRoles={detail.providerRoles}
      />

      <div className="glass-panel p-5">
        <h2 className="font-display font-bold text-bark-700 mb-3">Linked Roles</h2>
        <div className="space-y-2">
          {detail.campRoles.map((role: any) => (
            <div key={role.id} className="flex items-center justify-between rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
              <Link href={`/admin/camps/${role.campId}`} className="flex items-center gap-2 hover:text-pine-600">
                <span>{role.campName} <span className="text-bark-300">· {role.roleType}</span></span>
                <ExternalLink className="w-4 h-4" />
              </Link>
              <PersonRoleActions roleType="camp" roleId={role.id} />
            </div>
          ))}
          {detail.providerRoles.map((role: any) => (
            <div key={role.id} className="flex items-center justify-between rounded-lg border border-cream-300 px-3 py-2 text-sm text-bark-600">
              <Link href={`/admin/providers/${role.providerId}`} className="flex items-center gap-2 hover:text-pine-600">
                <span>{role.providerName} <span className="text-bark-300">· {role.roleType}</span></span>
                <ExternalLink className="w-4 h-4" />
              </Link>
              <PersonRoleActions roleType="provider" roleId={role.id} />
            </div>
          ))}
          {detail.campRoles.length === 0 && detail.providerRoles.length === 0 && (
            <p className="text-sm text-bark-300">No linked camp or provider roles yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
