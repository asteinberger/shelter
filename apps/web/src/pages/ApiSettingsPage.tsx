import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Braces,
  Check,
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  Plus,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { NavigationGuard } from '@/components/NavigationGuard';
import { SettingsHeader } from '@/components/settings/SettingsHeader';
import { Button, ErrorState, Field, SelectField, Skeleton } from '@/components/ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/i18n';
import type { ApiTokenSummary } from '@/types';
import { formatDate, formatRelative } from '@/utils/format';

interface TokenForm {
  name: string;
  access: 'read' | 'write';
  expiresInDays: string;
  currentPassword: string;
}

const emptyForm: TokenForm = {
  name: '',
  access: 'write',
  expiresInDays: '90',
  currentPassword: '',
};

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}

function accessLabel(token: ApiTokenSummary, t: ReturnType<typeof useI18n>['t']) {
  return token.scopes.length === 1
    ? t('Read only', 'Nur lesen')
    : t('Deploy & manage', 'Deployen & verwalten');
}

export function ApiSettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<TokenForm>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ secret: string; token: ApiTokenSummary } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const tokens = useQuery({
    queryKey: ['api-tokens'],
    queryFn: api.apiTokens,
    staleTime: 15_000,
  });

  const revokeToken = useMutation({
    mutationFn: api.revokeApiToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      toast.success(t('Access token revoked', 'Zugriffstoken widerrufen'));
    },
    onError: (error) => toast.error(t('Token could not be revoked', 'Token konnte nicht widerrufen werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  useEffect(() => {
    if (!revealed) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [revealed]);

  const serverUrl = typeof window === 'undefined' ? 'https://shelter.example.com' : window.location.origin;
  const loginCommand = `shelter login --server ${serverUrl}`;

  const closeCreateDialog = () => {
    if (creating) return;
    setCreateOpen(false);
    setForm(emptyForm);
    setCreateError(null);
  };

  const createToken = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.currentPassword) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.createApiToken({
        name: form.name.trim(),
        access: form.access,
        expiresInDays: Number(form.expiresInDays),
        currentPassword: form.currentPassword,
      });
      setRevealed({ secret: result.secret, token: result.apiToken });
      setCopyState('idle');
      setCreateOpen(false);
      setForm(emptyForm);
      await queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t('The token could not be created.', 'Der Token konnte nicht erstellt werden.'));
    } finally {
      setCreating(false);
    }
  };

  const copySecret = async () => {
    if (!revealed) return;
    try {
      await copyText(revealed.secret);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  const copyLoginCommand = async () => {
    try {
      await copyText(loginCommand);
      toast.success(t('Command copied', 'Befehl kopiert'));
    } catch {
      toast.error(t('Could not copy command', 'Befehl konnte nicht kopiert werden'));
    }
  };

  return (
    <div className="flex flex-col gap-8 sm:gap-10">
      <NavigationGuard
        when={Boolean(revealed)}
        locked
        title={t('Save your token first', 'Speichere zuerst deinen Token')}
        description={t(
          'This secret cannot be shown again. Copy it before leaving this page.',
          'Dieses Secret kann nicht erneut angezeigt werden. Kopiere es, bevor du diese Seite verlässt.',
        )}
        stayLabel={t('Return to token', 'Zurück zum Token')}
      />

      <SettingsHeader section="api" />

      <div className="grid max-w-6xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <Card>
          <CardHeader className="border-b">
            <div>
              <CardTitle>{t('Personal access tokens', 'Persönliche Zugriffstoken')}</CardTitle>
              <CardDescription className="mt-1">
                {t(
                  'Use short-lived tokens for CI, scripts, and the Shelter CLI. Secrets are shown exactly once.',
                  'Nutze zeitlich begrenzte Token für CI, Skripte und die Shelter CLI. Secrets werden genau einmal angezeigt.',
                )}
              </CardDescription>
            </div>
            <CardAction>
              <Dialog open={createOpen} onOpenChange={(open) => open ? setCreateOpen(true) : closeCreateDialog()}>
                <DialogTrigger asChild>
                  <Button><Plus aria-hidden="true" /> {t('Create token', 'Token erstellen')}</Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-lg">
                  <form className="grid gap-5" onSubmit={createToken}>
                    <DialogHeader>
                      <DialogTitle>{t('Create access token', 'Zugriffstoken erstellen')}</DialogTitle>
                      <DialogDescription>
                        {t(
                          'Choose the minimum access your automation needs. You will confirm this action with your administrator password.',
                          'Wähle nur den Zugriff, den deine Automation benötigt. Bestätige die Aktion mit deinem Admin-Passwort.',
                        )}
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                      <Field
                        label={t('Token name', 'Token-Name')}
                        name="tokenName"
                        value={form.name}
                        maxLength={80}
                        autoFocus
                        placeholder={t('Production deploys', 'Produktions-Deployments')}
                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                        hint={t('Describe where this token will be used.', 'Beschreibe, wo dieser Token eingesetzt wird.')}
                      />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <SelectField
                          label={t('Access', 'Zugriff')}
                          value={form.access}
                          onChange={(event) => setForm((current) => ({ ...current, access: event.target.value as TokenForm['access'] }))}
                        >
                          <option value="read">{t('Read only', 'Nur lesen')}</option>
                          <option value="write">{t('Deploy & manage', 'Deployen & verwalten')}</option>
                        </SelectField>
                        <SelectField
                          label={t('Expires after', 'Läuft ab nach')}
                          value={form.expiresInDays}
                          onChange={(event) => setForm((current) => ({ ...current, expiresInDays: event.target.value }))}
                        >
                          <option value="30">30 {t('days', 'Tagen')}</option>
                          <option value="90">90 {t('days', 'Tagen')}</option>
                          <option value="180">180 {t('days', 'Tagen')}</option>
                          <option value="365">365 {t('days', 'Tagen')}</option>
                        </SelectField>
                      </div>
                      <Field
                        label={t('Current administrator password', 'Aktuelles Admin-Passwort')}
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        value={form.currentPassword}
                        onChange={(event) => setForm((current) => ({ ...current, currentPassword: event.target.value }))}
                      />
                      {createError && (
                        <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                          {createError}
                        </p>
                      )}
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={closeCreateDialog} disabled={creating}>
                        {t('Cancel', 'Abbrechen')}
                      </Button>
                      <Button type="submit" loading={creating} disabled={!form.name.trim() || !form.currentPassword}>
                        {creating ? t('Creating …', 'Wird erstellt …') : t('Create token', 'Token erstellen')}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </CardAction>
          </CardHeader>

          {tokens.isLoading ? (
            <CardContent className="grid gap-3" role="status" aria-label={t('Loading access tokens', 'Zugriffstoken werden geladen')}>
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </CardContent>
          ) : tokens.isError ? (
            <CardContent>
              <ErrorState
                title={t('Access tokens unavailable', 'Zugriffstoken nicht verfügbar')}
                message={tokens.error instanceof Error ? tokens.error.message : undefined}
                action={<Button onClick={() => tokens.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
              />
            </CardContent>
          ) : (tokens.data?.length ?? 0) === 0 ? (
            <CardContent>
              <div className="grid min-h-52 place-items-center rounded-lg border border-dashed bg-muted/20 px-6 text-center">
                <div className="max-w-sm py-8">
                  <span className="mx-auto mb-4 grid size-10 place-items-center rounded-lg border bg-background shadow-sm">
                    <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <h2 className="font-medium">{t('No access tokens yet', 'Noch keine Zugriffstoken')}</h2>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    {t('Create one when you are ready to connect the CLI or an automation.', 'Erstelle einen Token, sobald du die CLI oder eine Automation verbinden möchtest.')}
                  </p>
                </div>
              </div>
            </CardContent>
          ) : (
            <div className="divide-y">
              {tokens.data?.map((token) => (
                <div key={token.id} className="grid gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="truncate font-medium">{token.name}</strong>
                      <Badge variant="secondary">{accessLabel(token, t)}</Badge>
                    </div>
                    <code className="mt-1.5 block truncate font-mono text-xs text-muted-foreground">{token.displayHint}</code>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5" title={formatDate(token.expiresAt)}>
                        <Clock3 className="size-3" aria-hidden="true" />
                        {t('Expires {time}', 'Läuft {time} ab', { time: formatRelative(token.expiresAt) })}
                      </span>
                      <span>
                        {token.lastUsedAt
                          ? t('Used {time}', '{time} verwendet', { time: formatRelative(token.lastUsedAt) })
                          : t('Never used', 'Noch nie verwendet')}
                      </span>
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" className="justify-self-start text-destructive hover:text-destructive sm:justify-self-end">
                        <Trash2 aria-hidden="true" /> {t('Revoke', 'Widerrufen')}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogMedia className="bg-destructive/10 text-destructive"><Trash2 /></AlertDialogMedia>
                        <AlertDialogTitle>{t('Revoke this token?', 'Diesen Token widerrufen?')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t(
                            '“{name}” will stop working immediately. This cannot be undone.',
                            '„{name}“ funktioniert danach sofort nicht mehr. Dies kann nicht rückgängig gemacht werden.',
                            { name: token.name },
                          )}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => revokeToken.mutate(token.id)}>
                          {t('Revoke token', 'Token widerrufen')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-4">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-lg border bg-background shadow-sm">
                  <TerminalSquare className="size-4" aria-hidden="true" />
                </span>
                <div>
                  <CardTitle>Shelter CLI</CardTitle>
                  <CardDescription>{t('Connect this installation', 'Diese Installation verbinden')}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100 shadow-inner dark:bg-black">
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-[11px] text-zinc-400">
                  <span className="inline-flex items-center gap-1.5"><Braces className="size-3" /> shell</span>
                  <button type="button" className="rounded p-1 transition-colors hover:bg-white/10 hover:text-white" onClick={copyLoginCommand} aria-label={t('Copy command', 'Befehl kopieren')}>
                    <Copy className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-xs leading-6"><code>{loginCommand}</code></pre>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('The CLI asks for the token securely and keeps it out of your shell history.', 'Die CLI fragt den Token sicher ab und hält ihn aus deinem Shell-Verlauf heraus.')}
              </p>
              <Separator />
              <Button asChild variant="outline" className="justify-between">
                <a href="/api/openapi.json" target="_blank" rel="noreferrer">
                  {t('Open API specification', 'API-Spezifikation öffnen')} <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            </CardContent>
          </Card>

          <Card size="sm">
            <CardContent className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs leading-5 text-muted-foreground">
                <strong className="font-medium text-foreground">{t('Safe by default.', 'Standardmäßig sicher.')}</strong>{' '}
                {t('Tokens expire automatically, can be revoked at any time, and are revoked when the administrator password changes.', 'Token laufen automatisch ab, können jederzeit widerrufen werden und werden bei einer Änderung des Admin-Passworts ungültig.')}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={Boolean(revealed)} onOpenChange={() => undefined}>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-xl"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <div className="mb-1 grid size-10 place-items-center rounded-lg border bg-muted/30">
              <KeyRound className="size-4" aria-hidden="true" />
            </div>
            <DialogTitle>{t('Your new access token', 'Dein neuer Zugriffstoken')}</DialogTitle>
            <DialogDescription>
              {t(
                'Copy this token now. For your security, Shelter will never show it again.',
                'Kopiere diesen Token jetzt. Zu deiner Sicherheit zeigt Shelter ihn nie wieder an.',
              )}
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="grid gap-3">
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs leading-6 selection:bg-primary selection:text-primary-foreground">
                    {revealed.secret}
                  </code>
                  <Button type="button" variant="outline" size="icon-sm" onClick={copySecret} aria-label={t('Copy token', 'Token kopieren')}>
                    {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </Button>
                </div>
              </div>
              <p className={copyState === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} aria-live="polite">
                {copyState === 'copied'
                  ? t('Copied to clipboard.', 'In die Zwischenablage kopiert.')
                  : copyState === 'error'
                    ? t('Copy failed. Select the token and copy it manually.', 'Kopieren fehlgeschlagen. Markiere den Token und kopiere ihn manuell.')
                    : t('Store it in a password manager or your CI secret store.', 'Speichere ihn in einem Passwortmanager oder dem Secret Store deiner CI.')}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => { setRevealed(null); setCopyState('idle'); }}>
              <Check aria-hidden="true" /> {t('I’ve saved the token', 'Token gespeichert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
