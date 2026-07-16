import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, LoaderCircle, RotateCcw, Save, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError } from '../api/client';
import type { Domain } from '../types';
import { useI18n } from '@/i18n';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Switch } from './ui/switch';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
}

function DomainAccessCard({ projectId, domain }: { projectId: string; domain: Domain }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [protectedSite, setProtectedSite] = useState(Boolean(domain.passwordProtectionEnabled));
  const [seoIndexing, setSeoIndexing] = useState(domain.seoIndexing ?? true);
  const [ttlHours, setTtlHours] = useState(domain.accessSessionTtlHours ?? 168);
  const [password, setPassword] = useState('');

  useEffect(() => {
    setProtectedSite(Boolean(domain.passwordProtectionEnabled));
    setSeoIndexing(domain.seoIndexing ?? true);
    setTtlHours(domain.accessSessionTtlHours ?? 168);
    setPassword('');
  }, [
    domain.accessSessionTtlHours,
    domain.id,
    domain.passwordProtectionEnabled,
    domain.seoIndexing,
  ]);

  const dirty = protectedSite !== Boolean(domain.passwordProtectionEnabled)
    || (!protectedSite && seoIndexing !== (domain.seoIndexing ?? true))
    || ttlHours !== (domain.accessSessionTtlHours ?? 168)
    || (protectedSite && password.length > 0);
  const passwordRequired = protectedSite && !domain.passwordConfigured && password.length < 8;
  const passwordInvalid = protectedSite && password.length > 0 && password.length < 8;

  const update = useMutation({
    mutationFn: () => api.updateDomainAccess(projectId, domain.id, {
      passwordProtectionEnabled: protectedSite,
      password: protectedSite && password ? password : undefined,
      accessSessionTtlHours: ttlHours,
      seoIndexing: protectedSite ? false : seoIndexing,
    }),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('Access settings saved', 'Zugriffseinstellungen gespeichert'), {
        description: domain.hostname,
      });
    },
    onError: (error) => toast.error(t('Settings could not be saved', 'Einstellungen konnten nicht gespeichert werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
    }),
  });

  const revoke = useMutation({
    mutationFn: () => api.revokeDomainAccessSessions(projectId, domain.id),
    onSuccess: () => toast.success(t('Shared access revoked', 'Geteilte Zugriffe widerrufen'), {
      description: t(
        'Visitors must enter the password again.',
        'Besucher müssen das Passwort erneut eingeben.',
      ),
    }),
    onError: (error) => toast.error(t('Sessions could not be revoked', 'Sitzungen konnten nicht widerrufen werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
    }),
  });

  const status = useMemo(() => {
    if (protectedSite) return t('Password protected', 'Passwortgeschützt');
    if (!seoIndexing) return t('Public · no indexing', 'Öffentlich · keine Indexierung');
    return t('Public · indexable', 'Öffentlich · indexierbar');
  }, [protectedSite, seoIndexing, t]);

  return (
    <article className="overflow-hidden rounded-xl border bg-background">
      <div className="flex flex-col gap-4 border-b bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`grid size-10 shrink-0 place-items-center rounded-xl border ${protectedSite ? 'border-primary/25 bg-primary/10 text-primary' : 'bg-background text-muted-foreground'}`}>
            {protectedSite ? <ShieldCheck className="size-5" /> : <Eye className="size-5" />}
          </div>
          <div className="min-w-0">
            <strong className="block truncate text-sm font-semibold">{domain.hostname}</strong>
            <span className="mt-0.5 block text-xs text-muted-foreground">{status}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {protectedSite && <Badge variant="secondary"><KeyRound /> {t('Shared password', 'Geteiltes Passwort')}</Badge>}
          {(protectedSite || !seoIndexing) && <Badge variant="outline"><EyeOff /> noindex</Badge>}
        </div>
      </div>

      <div className="divide-y">
        <div className="flex items-start justify-between gap-6 p-4">
          <div>
            <Label htmlFor={`protection-${domain.id}`} className="text-sm font-medium">
              {t('Password protection', 'Passwortschutz')}
            </Label>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {t(
                'Share the website and a separate site password. Visitors do not need a Shelter account.',
                'Teile die Website und ein separates Seitenpasswort. Besucher benötigen keinen Shelter-Account.',
              )}
            </p>
          </div>
          <Switch
            id={`protection-${domain.id}`}
            checked={protectedSite}
            onCheckedChange={(checked) => {
              setProtectedSite(checked);
              if (checked) setSeoIndexing(false);
            }}
            disabled={domain.status !== 'active' || update.isPending}
            aria-label={t('Toggle password protection', 'Passwortschutz umschalten')}
          />
        </div>

        {protectedSite && (
          <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_14rem]">
            <div className="space-y-2">
              <Label htmlFor={`password-${domain.id}`}>
                {domain.passwordConfigured
                  ? t('Set a new password', 'Neues Passwort festlegen')
                  : t('Site password', 'Seitenpasswort')}
              </Label>
              <Input
                id={`password-${domain.id}`}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={domain.passwordConfigured
                  ? t('Leave empty to keep the current password', 'Leer lassen, um das aktuelle Passwort zu behalten')
                  : t('At least 8 characters', 'Mindestens 8 Zeichen')}
                aria-invalid={passwordInvalid}
              />
              {passwordInvalid && (
                <p className="text-xs text-destructive">{t('Use at least 8 characters.', 'Nutze mindestens 8 Zeichen.')}</p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  'Stored as a one-way hash. Changing it immediately signs out all visitors.',
                  'Wird als Einweg-Hash gespeichert. Eine Änderung meldet alle Besucher sofort ab.',
                )}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`ttl-${domain.id}`}>{t('Remember access for', 'Zugriff merken für')}</Label>
              <NativeSelect
                id={`ttl-${domain.id}`}
                value={String(ttlHours)}
                onChange={(event) => setTtlHours(Number(event.target.value))}
              >
                <NativeSelectOption value="1">{t('1 hour', '1 Stunde')}</NativeSelectOption>
                <NativeSelectOption value="24">{t('1 day', '1 Tag')}</NativeSelectOption>
                <NativeSelectOption value="72">{t('3 days', '3 Tage')}</NativeSelectOption>
                <NativeSelectOption value="168">{t('7 days', '7 Tage')}</NativeSelectOption>
                <NativeSelectOption value="720">{t('30 days', '30 Tage')}</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        )}

        <div className="flex items-start justify-between gap-6 p-4">
          <div>
            <Label htmlFor={`seo-${domain.id}`} className="flex items-center gap-2 text-sm font-medium">
              <Search className="size-4 text-muted-foreground" />
              {t('Search engine indexing', 'Suchmaschinen-Indexierung')}
            </Label>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              {protectedSite
                ? t(
                    'Password-protected websites are always excluded from search results.',
                    'Passwortgeschützte Websites werden immer aus Suchergebnissen ausgeschlossen.',
                  )
                : t(
                    'When disabled, Shelter sends a strict X-Robots-Tag header for every response.',
                    'Wenn deaktiviert, sendet Shelter für jede Antwort einen strikten X-Robots-Tag-Header.',
                  )}
            </p>
          </div>
          <Switch
            id={`seo-${domain.id}`}
            checked={!protectedSite && seoIndexing}
            onCheckedChange={setSeoIndexing}
            disabled={protectedSite || domain.status !== 'active' || update.isPending}
            aria-label={t('Toggle search engine indexing', 'Suchmaschinen-Indexierung umschalten')}
          />
        </div>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <Button
          variant="ghost"
          className="justify-start text-muted-foreground"
          onClick={() => revoke.mutate()}
          disabled={!domain.passwordConfigured || revoke.isPending}
        >
          {revoke.isPending ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
          {t('Sign out all visitors', 'Alle Besucher abmelden')}
        </Button>
        <Button
          onClick={() => update.mutate()}
          disabled={!dirty || passwordRequired || passwordInvalid || update.isPending || domain.status !== 'active'}
        >
          {update.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {update.isPending ? t('Saving…', 'Wird gespeichert …') : t('Save access settings', 'Zugriff speichern')}
        </Button>
      </div>
    </article>
  );
}

export function DomainAccessSettings({ projectId, domains }: { projectId: string; domains: Domain[] }) {
  const { t } = useI18n();
  if (domains.length === 0) return null;
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t('Access & visibility', 'Zugriff & Sichtbarkeit')}</CardTitle>
        <CardDescription>
          {t(
            'Control sharing and search visibility independently for every connected domain.',
            'Steuere Freigabe und Sichtbarkeit für jede verbundene Domain separat.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Alert>
          <ShieldCheck />
          <AlertTitle>{t('Protection happens before your app', 'Der Schutz liegt vor deiner App')}</AlertTitle>
          <AlertDescription>
            {t(
              'No code changes or redeployment are required. Shelter checks access at the routing layer.',
              'Es sind keine Codeänderungen und kein neues Deployment nötig. Shelter prüft den Zugriff bereits im Routing.',
            )}
          </AlertDescription>
        </Alert>
        {domains.map((domain) => <DomainAccessCard key={domain.id} projectId={projectId} domain={domain} />)}
      </CardContent>
    </Card>
  );
}
