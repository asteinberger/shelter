import {
  AlertTriangle,
  Check,
  ExternalLink,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { CloudflareAccessProtection } from '../types';
import { currentLocale, useI18n } from '@/i18n';
import { Button } from './ui';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function confirmationDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(currentLocale() === 'de' ? 'de-DE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function cloudflareAccessApplicationsUrl(accountId?: string | null) {
  return accountId && /^[a-f0-9]{32}$/i.test(accountId)
    ? `https://dash.cloudflare.com/${accountId}/one/access/apps`
    : 'https://dash.cloudflare.com/?to=/:account/one/access/apps';
}

export function CloudflareAccessProtectionCard({
  accessProtection,
  accountId,
  pending = false,
  error,
  success,
  onConfirm,
  onRevoke,
}: {
  accessProtection: CloudflareAccessProtection;
  accountId?: string | null;
  pending?: boolean;
  error?: string | null;
  success?: 'confirmed' | 'revoked' | null;
  onConfirm: () => void;
  onRevoke: () => void;
}) {
  const { t } = useI18n();
  const confirmed = accessProtection.status === 'confirmed_by_admin';
  const hostname = accessProtection.panelDomain;
  const confirmedAt = confirmationDate(accessProtection.confirmedAt);

  if (!hostname || accessProtection.status === 'not_applicable') return null;

  const checklist = [
    t('Create a Self-hosted Access application for exactly {hostname}.', 'Erstelle eine Self-hosted-Access-Anwendung exakt für {hostname}.', { hostname }),
    t('Allow only your operator email or a dedicated identity group.', 'Erlaube ausschließlich deine Operator-E-Mail oder eine eigene Identitätsgruppe.'),
    t('Require MFA and remove public Everyone or Bypass rules.', 'Fordere MFA und entferne öffentliche Everyone- oder Bypass-Regeln.'),
  ];

  return (
    <Card
      aria-labelledby="cloudflare-access-protection-title"
      aria-busy={pending}
      className={confirmed ? 'border-success/30' : 'border-destructive/40 bg-destructive/[0.025]'}
    >
      <CardHeader className="gap-4 border-b sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('Step 4 · Production security', 'Schritt 4 · Produktionssicherheit')}
          </p>
          <CardTitle id="cloudflare-access-protection-title" className="flex items-center gap-2 text-lg">
            {confirmed
              ? <ShieldCheck className="size-5 text-success" aria-hidden="true" />
              : <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />}
            {t('Protect the Shelter panel', 'Shelter-Panel schützen')}
          </CardTitle>
          <CardDescription className="mt-1.5 max-w-2xl leading-6">
            {t(
              'The tunnel publishes the panel, but it does not restrict who may open it. Add Cloudflare Access before treating this hostname as production-safe.',
              'Der Tunnel veröffentlicht das Panel, beschränkt aber nicht, wer es öffnen darf. Richte Cloudflare Access ein, bevor du diesen Hostnamen als produktionssicher betrachtest.',
            )}
          </CardDescription>
        </div>
        <CardAction>
          <Badge variant={confirmed ? 'outline' : 'destructive'}>
            {confirmed
              ? t('Confirmed by administrator', 'Vom Administrator bestätigt')
              : t('Production unsafe', 'Produktion unsicher')}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-6">
        <div className="rounded-lg border bg-background/70 p-4">
          <p className="text-xs font-medium text-muted-foreground">{t('Panel hostname', 'Panel-Hostname')}</p>
          <code className="mt-1.5 block break-all font-mono text-sm font-semibold text-foreground">{hostname}</code>
        </div>

        <ol className="grid gap-3" aria-label={t('Cloudflare Access security checklist', 'Cloudflare-Access-Sicherheitscheckliste')}>
          {checklist.map((item, index) => (
            <li key={item} className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-3 text-sm leading-6">
              <span className="grid size-7 place-items-center rounded-full border bg-muted/30 text-xs font-semibold text-muted-foreground" aria-hidden="true">
                {index + 1}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ol>

        <Alert role="note" className="items-start">
          <LockKeyhole aria-hidden="true" />
          <AlertTitle>{t('Administrator confirmation only', 'Nur Administrator-Bestätigung')}</AlertTitle>
          <AlertDescription>
            {t(
              'Shelter does not inspect your Access application or policies automatically. Confirm only after you reviewed the exact hostname in Cloudflare.',
              'Shelter prüft deine Access-Anwendung oder Policies nicht automatisch. Bestätige erst, nachdem du den exakten Hostnamen in Cloudflare geprüft hast.',
            )}
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>{t('Confirmation could not be updated', 'Bestätigung konnte nicht aktualisiert werden')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {success === 'confirmed' && (
          <Alert role="status" className="[&>svg]:text-success">
            <Check aria-hidden="true" />
            <AlertTitle>{t('Administrator confirmation saved', 'Administrator-Bestätigung gespeichert')}</AlertTitle>
            <AlertDescription>{t('This confirmation stays tied to the exact panel hostname above.', 'Diese Bestätigung bleibt an den exakten Panel-Hostnamen oben gebunden.')}</AlertDescription>
          </Alert>
        )}
        {success === 'revoked' && (
          <Alert role="status" className="[&>svg]:text-warning">
            <RotateCcw aria-hidden="true" />
            <AlertTitle>{t('Confirmation revoked', 'Bestätigung widerrufen')}</AlertTitle>
            <AlertDescription>{t('Shelter now marks this panel hostname as production-unsafe again.', 'Shelter markiert diesen Panel-Hostnamen jetzt wieder als produktionsunsicher.')}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <a href={cloudflareAccessApplicationsUrl(accountId)} target="_blank" rel="noreferrer">
              {t('Open Access applications', 'Access-Anwendungen öffnen')} <ExternalLink aria-hidden="true" />
            </a>
          </Button>
          {confirmed ? (
            <Button type="button" variant="outline" onClick={onRevoke} loading={pending} disabled={pending} className="w-full sm:w-auto">
              {!pending && <RotateCcw aria-hidden="true" />}
              {pending ? t('Revoking confirmation …', 'Bestätigung wird widerrufen …') : t('Revoke confirmation', 'Bestätigung widerrufen')}
            </Button>
          ) : (
            <Button type="button" onClick={onConfirm} loading={pending} disabled={pending} className="w-full sm:w-auto">
              {!pending && <ShieldCheck aria-hidden="true" />}
              {pending ? t('Saving confirmation …', 'Bestätigung wird gespeichert …') : t('I configured these protections', 'Ich habe diese Schutzmaßnahmen eingerichtet')}
            </Button>
          )}
        </div>

        {confirmed && confirmedAt && (
          <p className="text-xs text-muted-foreground" role="status">
            {t('Administrator-confirmed on {date}.', 'Vom Administrator bestätigt am {date}.', { date: confirmedAt })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
