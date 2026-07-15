import type { ReactNode } from 'react';
import { Braces, Cloud, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { Button, PageIntro } from '@/components/ui';
import { GitHubIcon } from '@/components/GitHubIcon';

export type SettingsSection = 'cloudflare' | 'github' | 'api' | 'security';

export function SettingsHeader({
  section,
  status,
}: {
  section: SettingsSection;
  status?: ReactNode;
}) {
  const { t } = useI18n();
  const copy = {
    cloudflare: {
      title: t('Cloudflare & routing', 'Cloudflare & Routing'),
      description: t(
        'Manage Cloudflare access, your tunnel, and this panel’s domain.',
        'Verwalte den Cloudflare-Zugang, deinen Tunnel und die Domain dieses Panels.',
      ),
    },
    github: {
      title: 'GitHub',
      description: t(
        'Connect repositories securely and deploy new commits automatically.',
        'Verbinde Repositories sicher und deploye neue Commits automatisch.',
      ),
    },
    api: {
      title: 'API & CLI',
      description: t(
        'Create and revoke access tokens for automations and the Shelter CLI.',
        'Erstelle und widerrufe Zugriffstoken für Automationen und die Shelter CLI.',
      ),
    },
    security: {
      title: t('Security', 'Sicherheit'),
      description: t(
        'Protect administrative access to this Shelter workspace.',
        'Schütze den administrativen Zugang zu diesem Shelter-Workspace.',
      ),
    },
  } satisfies Record<SettingsSection, { title: string; description: string }>;

  const items = [
    { key: 'cloudflare' as const, to: '/settings/cloudflare', label: 'Cloudflare & Routing', icon: Cloud },
    { key: 'github' as const, to: '/settings/github', label: 'GitHub', icon: GitHubIcon },
    { key: 'api' as const, to: '/settings/api', label: 'API & CLI', icon: Braces },
    { key: 'security' as const, to: '/settings/security', label: t('Security', 'Sicherheit'), icon: ShieldCheck },
  ];

  return (
    <div className="grid gap-5">
      <PageIntro
        eyebrow={t('Settings', 'Einstellungen')}
        title={copy[section].title}
        description={copy[section].description}
        actions={status}
      />
      <nav className="flex gap-1 overflow-x-auto border-b pb-px" aria-label={t('Settings sections', 'Einstellungsbereiche')}>
        {items.map(({ key, to, label, icon: Icon }) => {
          const active = section === key;
          return (
            <Button key={key} asChild variant={active ? 'secondary' : 'ghost'} className="rounded-b-none">
              <Link to={to} aria-current={active ? 'page' : undefined}>
                <Icon aria-hidden="true" /> {label}
              </Link>
            </Button>
          );
        })}
      </nav>
    </div>
  );
}
