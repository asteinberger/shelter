import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  Check,
  CircleDot,
  Cloud,
  Copy,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  Network,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, api } from '../api/client';
import { Button, ErrorState, Field, SelectField, Skeleton, StatusBadge } from '../components/ui';
import { SettingsHeader, type SettingsSection } from '../components/settings/SettingsHeader';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { NavigationGuard } from '../components/NavigationGuard';
import { GitHubIcon } from '../components/GitHubIcon';
import { GitHubPreviewCapabilityNotice } from '../components/GitHubPreviewCapabilityNotice';
import { CloudflareAccessProtectionCard } from '../components/CloudflareAccessProtectionCard';
import {
  githubPreviewCapabilityStatus,
  shouldRefetchGitHubPreviewCapability,
  trustedGitHubAppUrl,
} from '../utils/github';
import { githubCallbackNotice } from '../utils/github-callback';
import { submitGitHubManifest } from '../utils/github-manifest';
import { currentLocale, localize, useI18n } from '@/i18n';
import type { CloudflareSettings } from '../types';

interface FormState {
  accountId: string;
  apiToken: string;
  tunnelName: string;
  panelDomain: string;
}

interface PasswordFormState {
  currentPassword: string;
  newPassword: string;
  confirmation: string;
}

type SaveMode = 'oauth' | 'api_token' | 'routing';
type CloudflareConfigField = Exclude<keyof FormState, 'apiToken'>;

interface ConnectionNotice {
  tone: 'success' | 'error';
  title: string;
  message: string;
}

const emptyForm: FormState = {
  accountId: '',
  apiToken: '',
  tunnelName: 'shelter',
  panelDomain: '',
};

const emptyPasswordForm: PasswordFormState = {
  currentPassword: '',
  newPassword: '',
  confirmation: '',
};

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]?.replace(/\.$/, '') ?? '';
}

function accountIdError(value: string) {
  const accountId = value.trim();
  if (!accountId) return localize('Enter the Cloudflare account ID.', 'Gib die Cloudflare Account-ID ein.');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) return localize('The account ID must contain exactly 32 hexadecimal characters.', 'Die Account-ID muss aus genau 32 Hexzeichen bestehen.');
  return undefined;
}

function tunnelNameError(value: string) {
  const tunnelName = value.trim();
  if (!tunnelName) return localize('Enter a tunnel name.', 'Gib einen Tunnel-Namen ein.');
  if (!/^[a-zA-Z0-9_.-]{2,64}$/.test(tunnelName)) {
    return localize('Use 2–64 characters: letters, numbers, period, underscore, or hyphen.', 'Verwende 2–64 Zeichen: Buchstaben, Ziffern, Punkt, Unterstrich oder Bindestrich.');
  }
  return undefined;
}

function panelDomainError(value: string) {
  const hostname = normalizeHostname(value);
  if (!hostname) return localize('Enter the panel hostname.', 'Gib den Hostnamen des Panels ein.');
  if (
    hostname.length < 3
    || hostname.length > 253
    || !hostname.includes('.')
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
  ) {
    return localize('Enter a valid hostname, for example panel.example.com.', 'Gib einen gültigen Hostnamen ein, zum Beispiel panel.example.com.');
  }
  return undefined;
}

function formatExpiry(value?: string | null) {
  if (!value) return null;
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) return null;
  return new Intl.DateTimeFormat(currentLocale() === 'de' ? 'de-DE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(expiry);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function InlineNotice({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'error' | 'info' | 'warning';
  title: string;
  children: ReactNode;
}) {
  const Icon = tone === 'success' ? Check : tone === 'error' || tone === 'warning' ? AlertTriangle : CircleDot;
  return (
    <Alert
      variant={tone === 'error' ? 'destructive' : 'default'}
      role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
      className={tone === 'success'
        ? '[&>svg]:text-success'
        : tone === 'warning'
          ? '[&>svg]:text-warning'
          : tone === 'info'
            ? '[&>svg]:text-info'
            : undefined}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const accessProtectionErrorMessage = (error: unknown) => {
    const code = error instanceof ApiError && error.details && typeof error.details === 'object'
      ? (error.details as { code?: unknown }).code
      : undefined;
    if (code === 'PANEL_DOMAIN_CHANGED') {
      return t('The panel hostname changed. Review the current hostname before confirming it.', 'Der Panel-Hostname wurde geändert. Prüfe den aktuellen Hostnamen, bevor du ihn bestätigst.');
    }
    if (code === 'PANEL_DOMAIN_REQUIRED') {
      return t('Set up a panel hostname before confirming Cloudflare Access.', 'Richte einen Panel-Hostnamen ein, bevor du Cloudflare Access bestätigst.');
    }
    return t('Shelter could not update the administrator confirmation. Refresh the settings and try again.', 'Shelter konnte die Administrator-Bestätigung nicht aktualisieren. Lade die Einstellungen neu und versuche es erneut.');
  };
  const passwordInvalidationSummary = (result: { invalidatedSessions: number; invalidatedApiTokens: number }) => {
    const sessions = result.invalidatedSessions === 1
      ? t('One other session was signed out.', 'Eine andere Sitzung wurde abgemeldet.')
      : t('{count} other sessions were signed out.', '{count} andere Sitzungen wurden abgemeldet.', { count: result.invalidatedSessions });
    const tokens = result.invalidatedApiTokens === 1
      ? t('One API token was revoked.', 'Ein API-Token wurde widerrufen.')
      : t('{count} API tokens were revoked.', '{count} API-Token wurden widerrufen.', { count: result.invalidatedApiTokens });
    return `${sessions} ${tokens}`;
  };
  const [form, setForm] = useState<FormState>(emptyForm);
  const [cloudflareTouched, setCloudflareTouched] = useState<Partial<Record<CloudflareConfigField, boolean>>>({});
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>(emptyPasswordForm);
  const [hydrated, setHydrated] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState<ConnectionNotice | null>(null);
  const [redirectCopied, setRedirectCopied] = useState(false);
  const oauthRedirecting = useRef(false);
  const settings = useQuery({
    queryKey: ['cloudflare-settings'],
    queryFn: api.cloudflare,
    enabled: section === 'cloudflare',
  });
  const githubSettings = useQuery({
    queryKey: ['github-settings'],
    queryFn: api.github,
    enabled: section === 'github',
    retry: false,
    refetchOnWindowFocus: (query) => (
      shouldRefetchGitHubPreviewCapability(query.state.data?.previewCapability) ? 'always' : false
    ),
    refetchOnReconnect: (query) => (
      shouldRefetchGitHubPreviewCapability(query.state.data?.previewCapability) ? 'always' : false
    ),
  });
  const registerGitHub = useMutation({
    mutationFn: api.startGitHubManifest,
    onMutate: () => toast.loading(t('Preparing GitHub App …', 'GitHub App wird vorbereitet …'), { id: 'github-register' }),
    onSuccess: ({ registrationUrl, manifest }) => {
      try {
        toast.dismiss('github-register');
        submitGitHubManifest(registrationUrl, manifest);
      } catch (error) {
        toast.error(t('GitHub App could not be opened', 'GitHub App konnte nicht geöffnet werden'), {
          description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
          id: 'github-register',
        });
      }
    },
    onError: (error) => toast.error(t('GitHub App could not be prepared', 'GitHub App konnte nicht vorbereitet werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
      id: 'github-register',
    }),
  });
  const disconnectGitHub = useMutation({
    mutationFn: api.disconnectGitHub,
    onMutate: () => toast.loading(t('Removing GitHub connection …', 'GitHub-Verbindung wird entfernt …'), { id: 'github-disconnect' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['github-repositories'] });
      void queryClient.invalidateQueries({ queryKey: ['github-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('GitHub connection removed', 'GitHub-Verbindung entfernt'), {
        description: t('The GitHub App remains on GitHub until you delete it there.', 'Die GitHub App bleibt bei GitHub bestehen, bis du sie dort löschst.'),
        id: 'github-disconnect',
      });
    },
    onError: (error) => toast.error(t('GitHub connection could not be removed', 'GitHub-Verbindung konnte nicht entfernt werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
      id: 'github-disconnect',
    }),
  });

  useEffect(() => {
    if (section !== 'cloudflare') return;
    const params = new URLSearchParams(window.location.search);
    const callbackStatus = params.get('cloudflare');
    if (!callbackStatus) return;

    if (callbackStatus === 'connected') {
      setConnectionNotice({
        tone: 'success',
        title: t('Cloudflare authorization confirmed', 'Cloudflare-Autorisierung bestätigt'),
        message: t('Sign-in succeeded. Finish setting up the tunnel now.', 'Die Anmeldung war erfolgreich. Schließe jetzt die Tunnel-Einrichtung ab.'),
      });
      toast.success(t('Cloudflare authorization confirmed', 'Cloudflare-Autorisierung bestätigt'), {
        description: t('Sign-in succeeded. Finish setting up the tunnel now.', 'Die Anmeldung war erfolgreich. Schließe jetzt die Tunnel-Einrichtung ab.'),
        id: 'cloudflare-callback',
      });
    } else {
      setConnectionNotice({
        tone: 'error',
        title: t('Cloudflare could not be connected', 'Cloudflare konnte nicht verbunden werden'),
        message: t('Sign-in was cancelled, expired, or rejected by Cloudflare. Please try again.', 'Die Anmeldung wurde abgebrochen, ist abgelaufen oder Cloudflare hat die Anfrage abgelehnt. Bitte versuche es erneut.'),
      });
      toast.error(t('Cloudflare could not be connected', 'Cloudflare konnte nicht verbunden werden'), {
        description: t('Sign-in was cancelled, expired, or rejected by Cloudflare. Please try again.', 'Die Anmeldung wurde abgebrochen, ist abgelaufen oder Cloudflare hat die Anfrage abgelehnt. Bitte versuche es erneut.'),
        id: 'cloudflare-callback',
      });
    }

    ['cloudflare', 'cloudflare_error', 'error', 'error_description', 'message', 'reason'].forEach((key) => params.delete(key));
    const remainingQuery = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ''}${window.location.hash}`,
    );
    void queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
    queryClient.removeQueries({ queryKey: ['cloudflare-zones'] });
    queryClient.removeQueries({ queryKey: ['cloudflare-hostname-availability'] });
  }, [queryClient, section, t]);

  useEffect(() => {
    if (section !== 'github') return;
    const params = new URLSearchParams(window.location.search);
    const callbackStatus = params.get('github');
    if (!callbackStatus) return;

    const callbackNotice = githubCallbackNotice(callbackStatus, params.get('message'), t);
    const callbackOptions = { description: callbackNotice.description, id: 'github-callback' };
    if (callbackNotice.tone === 'success') toast.success(callbackNotice.title, callbackOptions);
    else if (callbackNotice.tone === 'warning') toast.warning(callbackNotice.title, callbackOptions);
    else toast.error(callbackNotice.title, callbackOptions);

    ['github', 'github_error', 'error', 'error_description', 'message', 'reason'].forEach((key) => params.delete(key));
    const remainingQuery = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ''}${window.location.hash}`,
    );
    void queryClient.invalidateQueries({ queryKey: ['github-settings'] });
    void queryClient.invalidateQueries({ queryKey: ['github-repositories'] });
    void queryClient.invalidateQueries({ queryKey: ['github-preview-capability'] });
    void queryClient.invalidateQueries({ queryKey: ['project-pull-request-previews'] });
  }, [queryClient, section, t]);

  useEffect(() => {
    if (settings.data && !hydrated) {
      const onlyAccount = settings.data.accounts.length === 1 ? settings.data.accounts[0] : undefined;
      setForm({
        accountId: settings.data.accountId ?? onlyAccount?.id ?? '',
        apiToken: '',
        tunnelName: settings.data.tunnelName ?? 'shelter',
        panelDomain: settings.data.panelDomain ?? '',
      });
      setHydrated(true);
    }
  }, [settings.data, hydrated]);

  function update(field: keyof FormState, value: string) {
    if (save.isSuccess || save.isError) save.reset();
    if (field !== 'apiToken') {
      setCloudflareTouched((current) => ({ ...current, [field]: true }));
    }
    setForm((current) => ({ ...current, [field]: value }));
  }

  const save = useMutation({
    mutationFn: (mode: SaveMode) => api.saveCloudflare({
      accountId: form.accountId.trim(),
      tunnelName: form.tunnelName.trim(),
      panelDomain: normalizeHostname(form.panelDomain),
      ...(mode === 'api_token' && form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}),
    }),
    onMutate: (mode) => {
      const label = mode === 'oauth'
        ? t('Setting up tunnel …', 'Tunnel wird eingerichtet …')
        : mode === 'api_token'
          ? t('Saving API token …', 'API-Token wird gespeichert …')
          : t('Saving routing …', 'Routing wird gespeichert …');
      toast.loading(label, { id: `cloudflare-save-${mode}` });
    },
    onSuccess: (cloudflare, mode) => {
      const onlyAccount = cloudflare.accounts.length === 1 ? cloudflare.accounts[0] : undefined;
      setForm({
        accountId: cloudflare.accountId ?? onlyAccount?.id ?? '',
        apiToken: '',
        tunnelName: cloudflare.tunnelName ?? 'shelter',
        panelDomain: cloudflare.panelDomain ?? '',
      });
      setCloudflareTouched({});
      queryClient.setQueryData(['cloudflare-settings'], cloudflare);
      queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.removeQueries({ queryKey: ['cloudflare-zones'] });
      queryClient.removeQueries({ queryKey: ['cloudflare-hostname-availability'] });
      toast.success(mode === 'oauth' ? t('Tunnel configured', 'Tunnel eingerichtet') : mode === 'api_token' ? t('API token saved', 'API-Token gespeichert') : t('Routing updated', 'Routing aktualisiert'), {
        description: t('Shelter updated the Cloudflare connection and panel routing.', 'Shelter hat die Cloudflare-Verbindung und das Panel-Routing aktualisiert.'),
        id: `cloudflare-save-${mode}`,
      });
    },
    onError: (error, mode) => {
      toast.error(t('Cloudflare configuration could not be saved', 'Cloudflare-Konfiguration konnte nicht gespeichert werden'), {
        description: errorMessage(error, t('Cloudflare request failed.', 'Cloudflare-Anfrage fehlgeschlagen.')),
        id: `cloudflare-save-${mode}`,
      });
    },
  });
  const startOAuth = useMutation({
    mutationFn: api.startCloudflareOAuth,
    onMutate: () => toast.loading(t('Opening secure Cloudflare sign-in …', 'Sichere Cloudflare-Anmeldung wird geöffnet …'), { id: 'cloudflare-oauth' }),
    onSuccess: ({ authorizationUrl }) => {
      toast.dismiss('cloudflare-oauth');
      oauthRedirecting.current = true;
      window.location.assign(authorizationUrl);
    },
    onError: (error) => toast.error(t('Cloudflare sign-in could not be started', 'Cloudflare-Anmeldung konnte nicht gestartet werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
      id: 'cloudflare-oauth',
    }),
  });
  const test = useMutation({
    mutationFn: api.testCloudflare,
    onMutate: () => toast.loading(t('Testing Cloudflare connection …', 'Cloudflare-Verbindung wird geprüft …'), { id: 'cloudflare-test' }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      toast.success(t('Cloudflare is reachable', 'Cloudflare ist erreichbar'), {
        description: result.connections === 1
          ? t('Tunnel status: {status} · 1 active connection', 'Tunnelstatus: {status} · 1 aktive Verbindung', { status: result.tunnelStatus })
          : t('Tunnel status: {status} · {count} active connections', 'Tunnelstatus: {status} · {count} aktive Verbindungen', { status: result.tunnelStatus, count: result.connections }),
        id: 'cloudflare-test',
      });
    },
    onError: (error) => toast.error(t('Connection test failed', 'Verbindungstest fehlgeschlagen'), {
      description: errorMessage(error, t('Cloudflare is currently unavailable.', 'Cloudflare ist derzeit nicht erreichbar.')),
      id: 'cloudflare-test',
    }),
  });
  const confirmAccessProtection = useMutation({
    mutationFn: () => api.confirmCloudflareAccessProtection(settings.data?.accessProtection?.panelDomain ?? ''),
    onMutate: () => toast.loading(t('Saving administrator confirmation …', 'Administrator-Bestätigung wird gespeichert …'), { id: 'cloudflare-access-confirm' }),
    onSuccess: (accessProtection) => {
      queryClient.setQueryData<CloudflareSettings>(['cloudflare-settings'], (current) => (
        current ? { ...current, accessProtection } : current
      ));
      void queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('Administrator confirmation saved', 'Administrator-Bestätigung gespeichert'), {
        description: t('It is tied to this exact panel hostname.', 'Sie ist an diesen exakten Panel-Hostnamen gebunden.'),
        id: 'cloudflare-access-confirm',
      });
    },
    onError: (error) => toast.error(t('Confirmation could not be saved', 'Bestätigung konnte nicht gespeichert werden'), {
      description: accessProtectionErrorMessage(error),
      id: 'cloudflare-access-confirm',
    }),
  });
  const revokeAccessProtection = useMutation({
    mutationFn: api.revokeCloudflareAccessProtection,
    onMutate: () => toast.loading(t('Revoking administrator confirmation …', 'Administrator-Bestätigung wird widerrufen …'), { id: 'cloudflare-access-revoke' }),
    onSuccess: (accessProtection) => {
      queryClient.setQueryData<CloudflareSettings>(['cloudflare-settings'], (current) => (
        current ? { ...current, accessProtection } : current
      ));
      void queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('Administrator confirmation revoked', 'Administrator-Bestätigung widerrufen'), {
        description: t('Shelter now marks the panel as production-unsafe.', 'Shelter markiert das Panel jetzt als produktionsunsicher.'),
        id: 'cloudflare-access-revoke',
      });
    },
    onError: (error) => toast.error(t('Confirmation could not be revoked', 'Bestätigung konnte nicht widerrufen werden'), {
      description: accessProtectionErrorMessage(error),
      id: 'cloudflare-access-revoke',
    }),
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectCloudflare,
    onMutate: () => toast.loading(t('Removing Cloudflare authorization …', 'Cloudflare-Autorisierung wird entfernt …'), { id: 'cloudflare-disconnect' }),
    onSuccess: (cloudflare) => {
      const onlyAccount = cloudflare.accounts.length === 1 ? cloudflare.accounts[0] : undefined;
      setForm({
        accountId: cloudflare.accountId ?? onlyAccount?.id ?? '',
        apiToken: '',
        tunnelName: cloudflare.tunnelName ?? 'shelter',
        panelDomain: cloudflare.panelDomain ?? '',
      });
      setCloudflareTouched({});
      setHydrated(true);
      queryClient.setQueryData(['cloudflare-settings'], cloudflare);
      queryClient.invalidateQueries({ queryKey: ['cloudflare-settings'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      queryClient.removeQueries({ queryKey: ['cloudflare-zones'] });
      queryClient.removeQueries({ queryKey: ['cloudflare-hostname-availability'] });
      toast.success(t('Connection removed from Shelter', 'Verbindung aus Shelter entfernt'), {
        description: t('Cloudflare credentials were removed locally. Existing tunnels continue to run in Cloudflare.', 'Cloudflare-Zugangsdaten wurden lokal entfernt. Bestehende Tunnel laufen in Cloudflare weiter.'),
        id: 'cloudflare-disconnect',
      });
    },
    onError: (error) => toast.error(t('Cloudflare connection could not be disconnected', 'Cloudflare-Verbindung konnte nicht getrennt werden'), {
      description: errorMessage(error, t('Please try again.', 'Bitte versuche es erneut.')),
      id: 'cloudflare-disconnect',
    }),
  });
  const changePassword = useMutation({
    mutationFn: () => api.changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    }),
    onMutate: () => toast.loading(t('Updating password …', 'Passwort wird aktualisiert …'), { id: 'password-change' }),
    onSuccess: (result) => {
      setPasswordForm(emptyPasswordForm);
      void queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      toast.success(t('Password changed', 'Passwort geändert'), {
        description: passwordInvalidationSummary(result),
        id: 'password-change',
      });
    },
    onError: (error) => toast.error(t('The password could not be changed', 'Das Passwort konnte nicht geändert werden'), {
      description: errorMessage(error, t('Check your current password and try again.', 'Bitte prüfe dein aktuelles Passwort und versuche es erneut.')),
      id: 'password-change',
    }),
  });

  const cloudflareBusy = save.isPending
    || startOAuth.isPending
    || test.isPending
    || confirmAccessProtection.isPending
    || revokeAccessProtection.isPending
    || disconnect.isPending;

  function submitOAuthSetup(event: FormEvent) {
    event.preventDefault();
    if (cloudflareBusy || !canSaveOAuth) {
      setCloudflareTouched({ accountId: true, tunnelName: true, panelDomain: true });
      return;
    }
    save.mutate('oauth');
  }

  function submitTokenFallback(event: FormEvent) {
    event.preventDefault();
    if (cloudflareBusy || !canSaveToken) {
      setCloudflareTouched({ accountId: true, tunnelName: true, panelDomain: true });
      return;
    }
    save.mutate('api_token');
  }

  function submitRouting(event: FormEvent) {
    event.preventDefault();
    if (cloudflareBusy || !canSaveOAuth) {
      setCloudflareTouched({ accountId: true, tunnelName: true, panelDomain: true });
      return;
    }
    save.mutate('routing');
  }

  async function copyRedirectUri() {
    const redirectUri = settings.data?.oauthRedirectUri;
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setRedirectCopied(true);
      toast.success(t('Callback URL copied', 'Callback URL kopiert'), {
        description: t('You can now paste it into the Cloudflare configuration.', 'Du kannst sie jetzt in die Cloudflare-Konfiguration einfügen.'),
        id: 'copy-oauth-callback',
      });
      window.setTimeout(() => setRedirectCopied(false), 1800);
    } catch {
      toast.error(t('Callback URL could not be copied', 'Callback URL konnte nicht kopiert werden'), {
        description: t('Select the URL manually and copy it into the Cloudflare configuration.', 'Markiere die URL bitte manuell und kopiere sie in die Cloudflare-Konfiguration.'),
        id: 'copy-oauth-callback',
      });
    }
  }

  function updatePassword(field: keyof PasswordFormState, value: string) {
    if (changePassword.isSuccess || changePassword.isError) changePassword.reset();
    setPasswordForm((current) => ({ ...current, [field]: value }));
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (
      !changePassword.isPending
      && passwordForm.currentPassword
      && passwordForm.newPassword.length >= 16
      && passwordForm.newPassword !== passwordForm.currentPassword
      && passwordForm.confirmation === passwordForm.newPassword
    ) {
      changePassword.mutate();
    }
  }

  const configured = Boolean(settings.data?.configured);
  const authorized = Boolean(settings.data?.authorized);
  const oauthPending = Boolean(settings.data?.oauthPending);
  const panelAccessProtection = settings.data?.accessProtection;
  const cloudflareErrors = {
    accountId: accountIdError(form.accountId),
    tunnelName: tunnelNameError(form.tunnelName),
    panelDomain: panelDomainError(form.panelDomain),
  };
  const initialAccountId = settings.data?.accountId
    ?? (settings.data?.accounts.length === 1 ? settings.data.accounts[0]?.id : undefined)
    ?? '';
  const cloudflareConfigDirty = form.accountId.trim().toLowerCase() !== initialAccountId.trim().toLowerCase()
    || form.tunnelName.trim() !== (settings.data?.tunnelName ?? '').trim()
    || normalizeHostname(form.panelDomain) !== normalizeHostname(settings.data?.panelDomain ?? '');
  const canSaveOAuth = Boolean(
    authorized
    && !cloudflareErrors.accountId
    && !cloudflareErrors.tunnelName
    && !cloudflareErrors.panelDomain
    && (oauthPending || !configured || cloudflareConfigDirty)
  );
  const canSaveToken = Boolean(
    !cloudflareErrors.accountId
    && !cloudflareErrors.tunnelName
    && !cloudflareErrors.panelDomain
    && (form.apiToken.trim() || settings.data?.hasApiToken)
    && (form.apiToken.trim() || !configured || cloudflareConfigDirty)
  );
  const activeAccount = settings.data?.accounts.find((account) => account.id === settings.data?.accountId)
    ?? (oauthPending && settings.data?.accounts.length === 1 ? settings.data.accounts[0] : undefined);
  const oauthExpiry = formatExpiry(settings.data?.oauthExpiresAt);
  const passwordIsUnchanged = Boolean(passwordForm.newPassword) && passwordForm.newPassword === passwordForm.currentPassword;
  const confirmationDoesNotMatch = Boolean(passwordForm.confirmation) && passwordForm.confirmation !== passwordForm.newPassword;
  const canChangePassword = Boolean(
    passwordForm.currentPassword
    && passwordForm.newPassword.length >= 16
    && !passwordIsUnchanged
    && passwordForm.confirmation === passwordForm.newPassword,
  );
  const hasUnsavedCloudflareChanges = section === 'cloudflare'
    && hydrated
    && Boolean(settings.data)
    && (cloudflareConfigDirty || Boolean(form.apiToken));
  const hasUnsavedPasswordChanges = section === 'security'
    && Object.values(passwordForm).some(Boolean);
  const hasUnsavedChanges = hasUnsavedCloudflareChanges || hasUnsavedPasswordChanges;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (oauthRedirecting.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [hasUnsavedChanges]);

  const unsavedChangesGuard = (
    <NavigationGuard
      when={hasUnsavedChanges && !oauthRedirecting.current}
      title={t('Discard unsaved changes?', 'Ungespeicherte Änderungen verwerfen?')}
      description={hasUnsavedCloudflareChanges
        ? t('Your Cloudflare configuration changes have not been saved.', 'Deine Änderungen an der Cloudflare-Konfiguration wurden noch nicht gespeichert.')
        : t('Your new administrator-password entries have not been saved.', 'Deine Eingaben für das neue Admin-Passwort wurden noch nicht gespeichert.')}
    />
  );

  if (section === 'github') {
    const github = githubSettings.data;
    const installations = github?.installations ?? [];
    const connected = Boolean(github?.connected && installations.length > 0);
    const githubAppUrl = trustedGitHubAppUrl(github?.appUrl);
    const githubInstallUrl = trustedGitHubAppUrl(github?.installUrl);
    const previewCapabilityStatus = githubPreviewCapabilityStatus(github?.previewCapability);
    const previewCapabilityNeedsUpdate = previewCapabilityStatus === 'update';

    return (
      <div className="flex flex-col gap-8 sm:gap-10">
        <SettingsHeader
          section="github"
          status={<StatusBadge status={githubSettings.isLoading ? 'pending' : connected ? 'connected' : github?.configured ? 'ready' : 'offline'} />}
        />

        {githubSettings.isLoading ? (
          <div className="grid max-w-4xl gap-5" role="status" aria-label={t('Loading GitHub settings', 'GitHub-Einstellungen werden geladen')}>
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : githubSettings.isError ? (
          <ErrorState
            title={t('GitHub configuration unavailable', 'GitHub-Konfiguration nicht verfügbar')}
            message={githubSettings.error instanceof Error ? githubSettings.error.message : undefined}
            action={<Button onClick={() => githubSettings.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
          />
        ) : (
          <>
            {github?.error && (
              <div className="max-w-4xl">
                <InlineNotice tone="warning" title={t('GitHub reports a problem', 'GitHub meldet ein Problem')}>{github.error}</InlineNotice>
              </div>
            )}

            {!github?.configured ? (
              <section className="grid max-w-5xl items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]" aria-label={t('Register GitHub App', 'GitHub App registrieren')}>
                <Card>
                  <CardHeader className="border-b">
                    <SectionHeading
                      eyebrow={t('One-time setup', 'Einmalige Einrichtung')}
                      title={t('Register GitHub App', 'GitHub App registrieren')}
                      description={t('Shelter creates a dedicated app for this server through the official GitHub App Manifest. No passwords or personal tokens are needed.', 'Shelter erstellt über das offizielle GitHub-App-Manifest eine eigene App für diesen Server. Passwörter oder persönliche Tokens werden nicht benötigt.')}
                    />
                  </CardHeader>
                  <CardContent className="grid gap-6">
                    <ul className="grid gap-3 text-sm" aria-label={t('GitHub App permissions', 'Berechtigungen der GitHub App')}>
                      {[
                        [t('Read repositories', 'Repositories lesen'), t('Fetch source code and branches for deployments', 'Quellcode und Branches für Deployments abrufen')],
                        [t('Report deployments', 'Deployments melden'), t('Show commit status directly on GitHub', 'Commit-Status direkt auf GitHub anzeigen')],
                        [t('Receive webhooks', 'Webhooks empfangen'), t('Deploy new commits automatically', 'Neue Commits automatisch bereitstellen')],
                      ].map(([title, description]) => (
                        <li key={title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3">
                          <span className="mt-0.5 grid size-7 place-items-center rounded-md border bg-muted/30 text-muted-foreground">
                            <Check className="size-3.5" aria-hidden="true" />
                          </span>
                          <span>
                            <strong className="block font-medium">{title}</strong>
                            <small className="mt-0.5 block leading-5 text-muted-foreground">{description}</small>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {registerGitHub.isError && (
                      <InlineNotice tone="error" title={t('GitHub App could not be prepared', 'GitHub App konnte nicht vorbereitet werden')}>
                        {errorMessage(registerGitHub.error, t('Please try again.', 'Bitte versuche es erneut.'))}
                      </InlineNotice>
                    )}
                    <div className="flex flex-col items-start gap-2.5">
                      <Button
                        type="button"
                        onClick={() => registerGitHub.mutate()}
                        loading={registerGitHub.isPending}
                        className="w-full sm:w-auto"
                      >
                        {!registerGitHub.isPending && <GitHubIcon aria-hidden="true" />}
                        {registerGitHub.isPending ? t('Opening GitHub …', 'GitHub wird geöffnet …') : t('Register GitHub App', 'GitHub App registrieren')}
                        {!registerGitHub.isPending && <ArrowRight aria-hidden="true" />}
                      </Button>
                      <p className="text-xs text-muted-foreground">{t('You review and confirm the app directly on GitHub.', 'Du prüfst und bestätigst die App anschließend direkt bei GitHub.')}</p>
                    </div>
                  </CardContent>
                </Card>

                <aside className="border-t pt-6 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6" aria-labelledby="github-security-title">
                  <h2 id="github-security-title" className="text-base font-semibold">{t('Secure from the start', 'Sicher von Anfang an')}</h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {t('A GitHub App can access only the organizations and repositories you explicitly select on GitHub.', 'Eine GitHub App erhält nur Zugriff auf die Organisationen und Repositories, die du bei GitHub ausdrücklich auswählst.')}
                  </p>
                  <Separator className="my-5" />
                  <div className="flex items-start gap-2.5 text-xs leading-5 text-muted-foreground">
                    <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <p><strong className="font-medium text-foreground">{t('No personal access token.', 'Kein Personal Access Token.')}</strong> {t('Short-lived installation tokens are generated server-side only.', 'Kurzlebige Installationstokens werden ausschließlich serverseitig erzeugt.')}</p>
                  </div>
                </aside>
              </section>
            ) : (
              <div className="grid max-w-4xl gap-5">
                {previewCapabilityNeedsUpdate && (
                  <GitHubPreviewCapabilityNotice
                    capability={github.previewCapability}
                    refreshing={githubSettings.isFetching}
                    onRetry={() => githubSettings.refetch()}
                  />
                )}

                <Card aria-labelledby="github-app-title">
                  <CardHeader className="gap-4 border-b sm:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <CardTitle id="github-app-title" className="flex items-center gap-2 text-lg">
                        <GitHubIcon className="size-5" aria-hidden="true" />
                        <span className="truncate">{github.appName ?? 'Shelter GitHub App'}</span>
                      </CardTitle>
                      <CardDescription className="mt-1">{t('Dedicated GitHub App for this Shelter server', 'Eigene GitHub App für diesen Shelter-Server')}</CardDescription>
                    </div>
                    <StatusBadge status={connected ? 'connected' : 'ready'} />
                  </CardHeader>
                  <CardContent className="grid gap-5">
                    <dl className="grid gap-5 sm:grid-cols-3">
                      <div className="min-w-0">
                        <dt className="text-sm text-muted-foreground">App</dt>
                        <dd className="mt-1 truncate text-sm font-medium">{github.appSlug ? `@${github.appSlug}` : github.appName}</dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted-foreground">{t('Installations', 'Installationen')}</dt>
                        <dd className="mt-1 text-sm font-medium tabular-nums">{installations.length}</dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted-foreground">{t('PR previews', 'PR-Previews')}</dt>
                        <dd className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                          {previewCapabilityNeedsUpdate
                            ? <AlertTriangle className="size-3.5 text-warning" aria-hidden="true" />
                            : previewCapabilityStatus === 'unavailable'
                              ? <CircleDot className="size-3.5 text-muted-foreground" aria-hidden="true" />
                              : <GitPullRequest className="size-3.5" aria-hidden="true" />}
                          {previewCapabilityNeedsUpdate
                            ? t('Update required', 'Aktualisierung nötig')
                            : previewCapabilityStatus === 'unavailable'
                              ? t('Check unavailable', 'Prüfung nicht verfügbar')
                              : t('Ready', 'Bereit')}
                        </dd>
                      </div>
                    </dl>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      {githubAppUrl && (
                        <Button asChild variant="outline" className="w-full sm:w-auto">
                          <a href={githubAppUrl} target="_blank" rel="noreferrer">{t('Manage app', 'App verwalten')} <ExternalLink aria-hidden="true" /></a>
                        </Button>
                      )}
                      {githubInstallUrl && (
                        <Button asChild className="w-full sm:w-auto">
                          <a href={githubInstallUrl}>{t('Add installation', 'Installation hinzufügen')} <ArrowRight aria-hidden="true" /></a>
                        </Button>
                      )}
                      {connected && (
                        <Button asChild variant="secondary" className="w-full sm:w-auto">
                          <Link to="/projects/new">{t('Project from repository', 'Projekt aus Repository')} <ArrowRight aria-hidden="true" /></Link>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card aria-labelledby="github-installations-title">
                  <CardHeader className="border-b">
                    <CardTitle id="github-installations-title">{t('Installations', 'Installationen')}</CardTitle>
                    <CardDescription>{t('Accounts and organizations from which Shelter may select repositories.', 'Accounts und Organisationen, aus denen Shelter Repositories auswählen darf.')}</CardDescription>
                  </CardHeader>
                  <CardContent className="p-2">
                    {installations.length > 0 ? (
                      <ul className="divide-y">
                        {installations.map((installation) => {
                          const login = installation.accountLogin ?? installation.account?.login ?? 'GitHub Account';
                          const rawAccountType = installation.accountType ?? installation.account?.type ?? 'Account';
                          const accountType = rawAccountType === 'Organization' ? t('Organization', 'Organisation') : rawAccountType === 'User' ? t('Personal account', 'Persönlicher Account') : rawAccountType;
                          return (
                            <li key={String(installation.id)} className="flex min-w-0 items-center gap-3 px-3 py-3.5">
                              <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted/30"><GitHubIcon className="size-4" aria-hidden="true" /></span>
                              <div className="min-w-0 flex-1">
                                <strong className="block truncate text-sm font-medium">{login}</strong>
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                  {accountType} · {installation.repositorySelection === 'all' ? t('All repositories', 'Alle Repositories') : t('Selected repositories', 'Ausgewählte Repositories')}
                                </span>
                              </div>
                              {installation.suspendedAt ? <StatusBadge status="offline" /> : <StatusBadge status="connected" />}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="grid min-h-40 place-items-center rounded-lg border border-dashed bg-muted/15 p-6 text-center">
                        <div>
                          <GitHubIcon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                          <strong className="mt-3 block text-sm">{t('No installation yet', 'Noch keine Installation')}</strong>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('Install the app in your account or an organization.', 'Installiere die App in deinem Account oder einer Organisation.')}</p>
                          {githubInstallUrl && <Button asChild size="sm" className="mt-4"><a href={githubInstallUrl}>{t('Install now', 'Jetzt installieren')} <ArrowRight /></a></Button>}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="border-destructive/20">
                  <CardHeader>
                    <CardTitle className="text-base">{t('Remove GitHub connection', 'GitHub-Verbindung entfernen')}</CardTitle>
                    <CardDescription>{t('Removes app credentials and installations from Shelter. GitHub projects will no longer deploy automatically.', 'Entfernt App-Zugangsdaten und Installationen aus Shelter. GitHub-Projekte deployen danach nicht mehr automatisch.')}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex justify-end">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="danger" disabled={disconnectGitHub.isPending} loading={disconnectGitHub.isPending} className="w-full sm:w-auto">
                          {!disconnectGitHub.isPending && <Unplug aria-hidden="true" />} {t('Remove GitHub connection', 'GitHub-Verbindung entfernen')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogMedia className="bg-destructive/10 text-destructive"><Unplug aria-hidden="true" /></AlertDialogMedia>
                          <AlertDialogTitle>{t('Remove GitHub from Shelter?', 'GitHub aus Shelter entfernen?')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t('Auto-deploy and private repository access will stop working. The GitHub App itself remains on GitHub.', 'Auto-Deploys und private Repository-Zugriffe funktionieren anschließend nicht mehr. Die GitHub App selbst bleibt bei GitHub bestehen.')}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => disconnectGitHub.mutate()} disabled={disconnectGitHub.isPending}>
                            {t('Remove connection', 'Verbindung entfernen')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (section === 'security') {
    return (
      <>
        {unsavedChangesGuard}
        <div className="flex flex-col gap-8">
          <SettingsHeader section="security" />

          <section aria-labelledby="password-settings-title" className="w-full max-w-[40rem]">
            <Card>
            <CardHeader className="border-b">
              <CardTitle id="password-settings-title" className="text-lg">{t('Change administrator password', 'Admin-Passwort ändern')}</CardTitle>
              <CardDescription>
                {t('Choose a long, unique password. All other active sessions are signed out after the change.', 'Wähle ein langes, einzigartiges Passwort. Nach der Änderung werden alle anderen aktiven Sitzungen automatisch abgemeldet.')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-5" onSubmit={submitPassword}>
                <div className="grid gap-4">
                  <Field
                    label={t('Current password', 'Aktuelles Passwort')}
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    maxLength={1024}
                    value={passwordForm.currentPassword}
                    onChange={(event) => updatePassword('currentPassword', event.target.value)}
                    disabled={changePassword.isPending}
                    required
                  />
                  <Field
                    label={t('New password', 'Neues Passwort')}
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={16}
                    maxLength={1024}
                    value={passwordForm.newPassword}
                    onChange={(event) => updatePassword('newPassword', event.target.value)}
                    hint={t('At least 16 characters; ideally a long passphrase used only here', 'Mindestens 16 Zeichen; am besten eine lange, nur hier verwendete Passphrase')}
                    error={passwordForm.newPassword.length > 0 && passwordForm.newPassword.length < 16
                      ? t('{count} more characters required', 'Noch {count} Zeichen erforderlich', { count: 16 - passwordForm.newPassword.length })
                      : passwordIsUnchanged ? t('The new password must differ from the current password', 'Das neue Passwort muss sich vom aktuellen unterscheiden') : undefined}
                    disabled={changePassword.isPending}
                    required
                  />
                  <Field
                    label={t('Confirm new password', 'Neues Passwort bestätigen')}
                    name="passwordConfirmation"
                    type="password"
                    autoComplete="new-password"
                    minLength={16}
                    maxLength={1024}
                    value={passwordForm.confirmation}
                    onChange={(event) => updatePassword('confirmation', event.target.value)}
                    error={confirmationDoesNotMatch ? t('The passwords do not match', 'Die Passwörter stimmen nicht überein') : undefined}
                    disabled={changePassword.isPending}
                    required
                  />
                </div>

                <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {t('Your current session remains active; all other devices are signed out and every API token is revoked.', 'Deine aktuelle Sitzung bleibt bestehen; alle anderen Geräte werden abgemeldet und alle API-Token widerrufen.')}
                </p>
                {changePassword.isError && (
                  <InlineNotice tone="error" title={t('The password could not be changed', 'Das Passwort konnte nicht geändert werden')}>
                    {changePassword.error instanceof Error ? changePassword.error.message : t('Check your entries and try again.', 'Bitte prüfe deine Eingaben und versuche es erneut.')}
                  </InlineNotice>
                )}
                {changePassword.isSuccess && (
                  <InlineNotice tone="success" title={t('Password changed', 'Passwort geändert')}>
                    {passwordInvalidationSummary(changePassword.data)}
                  </InlineNotice>
                )}
                <div className="flex justify-end">
                  <Button type="submit" loading={changePassword.isPending} disabled={!canChangePassword || changePassword.isPending} className="w-full sm:w-auto">
                    {changePassword.isPending ? t('Updating password …', 'Passwort wird aktualisiert …') : t('Update password', 'Passwort aktualisieren')} {!changePassword.isPending && <ArrowRight aria-hidden="true" />}
                  </Button>
                </div>
              </form>
            </CardContent>
            </Card>
          </section>
        </div>
      </>
    );
  }

  if (settings.isLoading) {
    return (
      <div className="grid gap-8" role="status" aria-label={t('Loading Cloudflare settings', 'Cloudflare-Einstellungen werden geladen')}>
        <SettingsHeader section="cloudflare" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-[28rem] max-w-4xl rounded-xl" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <div className="grid gap-8">
        <SettingsHeader section="cloudflare" />
        <ErrorState
          title={t('Cloudflare configuration unavailable', 'Cloudflare-Konfiguration nicht verfügbar')}
          message={settings.error instanceof Error ? settings.error.message : undefined}
          action={<Button onClick={() => settings.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  return (
    <>
      {unsavedChangesGuard}
      <div className="flex flex-col gap-8 sm:gap-10">
        <SettingsHeader
        section="cloudflare"
        status={<StatusBadge status={oauthPending ? 'pending' : settings.data?.connected ? 'connected' : configured ? 'ready' : 'offline'} />}
        />

      {!configured && (
        <Alert role="note" className="items-start p-4">
          <Cloud aria-hidden="true" />
          <AlertTitle>Cloudflare Tunnel</AlertTitle>
          <AlertDescription>
            {t('Shelter connects outbound to Cloudflare over an encrypted tunnel. The panel and projects remain available without opening public ports on the VPS.', 'Shelter verbindet sich ausgehend und verschlüsselt mit Cloudflare. So bleiben Panel und Projekte erreichbar, ohne öffentliche Ports am VPS zu öffnen.')}
          </AlertDescription>
        </Alert>
      )}

      <section className={configured ? 'grid max-w-4xl items-start gap-6' : 'grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]'}>
        <div className="grid min-w-0 gap-5">
          {connectionNotice && (
            <InlineNotice tone={connectionNotice.tone} title={connectionNotice.title}>
              {connectionNotice.message}
            </InlineNotice>
          )}

          {authorized && configured && !oauthPending && (
            <Card aria-labelledby="cloudflare-account-title">
              <CardHeader className="gap-4 border-b sm:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <CardTitle id="cloudflare-account-title" className="truncate text-lg">
                    {t('Cloudflare connected', 'Cloudflare verbunden')}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {settings.data?.authMethod === 'api_token' ? t('Using an encrypted stored API token', 'Über einen verschlüsselt gespeicherten API-Token') : t('Authorized through your Cloudflare login', 'Über deinen Cloudflare Login autorisiert')}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <StatusBadge status={settings.data?.connected ? 'connected' : 'ready'} />
                </div>
              </CardHeader>

              <CardContent className="grid gap-5">
                <dl className="grid gap-5 sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-sm text-muted-foreground">{t('Account', 'Konto')}</dt>
                    <dd className="mt-1 truncate text-sm font-medium">{activeAccount?.name || t('Cloudflare account', 'Cloudflare-Konto')}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-sm text-muted-foreground">Tunnel</dt>
                    <dd className="mt-1 truncate text-sm font-medium">{settings.data?.tunnelName || t('Not configured yet', 'Noch nicht eingerichtet')}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-sm text-muted-foreground">{t('Panel domain', 'Panel-Domain')}</dt>
                    <dd className="mt-1 truncate text-sm font-medium">
                      {settings.data?.panelDomain ? (
                        <a className="inline-flex max-w-full items-center gap-1 hover:underline hover:underline-offset-4" href={`https://${settings.data.panelDomain}`} target="_blank" rel="noreferrer">
                          <span className="truncate">{settings.data.panelDomain}</span><ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                        </a>
                      ) : t('Hostname missing', 'Hostname fehlt')}
                    </dd>
                  </div>
                </dl>

                {settings.data?.reconnectRequired && (
                  <InlineNotice tone="warning" title={t('Reconnect Cloudflare', 'Cloudflare erneut verbinden')}>
                    {t('OAuth access expired or was revoked.', 'Der OAuth-Zugang ist abgelaufen oder wurde widerrufen.')}
                  </InlineNotice>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {settings.data?.reconnectRequired && (
                    <Button
                      type="button"
                      onClick={() => {
                        if (!cloudflareBusy) startOAuth.mutate();
                      }}
                      loading={startOAuth.isPending}
                      disabled={!settings.data?.oauthAvailable || cloudflareBusy}
                      className="sm:w-auto"
                    >
                      {!startOAuth.isPending && <RefreshCw aria-hidden="true" />} {startOAuth.isPending ? t('Opening sign-in …', 'Anmeldung wird geöffnet …') : t('Reconnect Cloudflare', 'Cloudflare neu verbinden')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!cloudflareBusy) test.mutate();
                    }}
                    loading={test.isPending}
                    disabled={!configured || cloudflareBusy}
                    className="sm:w-auto"
                  >
                    {!test.isPending && <CircleDot aria-hidden="true" />} {test.isPending ? t('Testing connection …', 'Verbindung wird geprüft …') : t('Test connection', 'Verbindung testen')}
                  </Button>
                </div>

                {test.isSuccess && (
                  <InlineNotice tone="success" title={t('Cloudflare is reachable', 'Cloudflare ist erreichbar')}>
                    {test.data.connections === 1
                      ? t('Tunnel status: {status} · 1 active connection', 'Tunnelstatus: {status} · 1 aktive Verbindung', { status: test.data.tunnelStatus })
                      : t('Tunnel status: {status} · {count} active connections', 'Tunnelstatus: {status} · {count} aktive Verbindungen', { status: test.data.tunnelStatus, count: test.data.connections })}
                  </InlineNotice>
                )}
                {test.isError && (
                  <InlineNotice tone="error" title={t('Connection test failed', 'Verbindungstest fehlgeschlagen')}>
                    {errorMessage(test.error, t('Cloudflare is currently unavailable.', 'Cloudflare ist derzeit nicht erreichbar.'))}
                  </InlineNotice>
                )}
                {startOAuth.isError && (
                  <InlineNotice tone="error" title={t('Cloudflare sign-in could not be started', 'Cloudflare-Anmeldung konnte nicht gestartet werden')}>
                    {errorMessage(startOAuth.error, t('Please try again.', 'Bitte versuche es erneut.'))}
                  </InlineNotice>
                )}
              </CardContent>
            </Card>
          )}

          {!authorized && settings.data?.oauthAvailable && (
            <Card aria-labelledby="oauth-entry-title">
              <CardHeader>
                <CardTitle id="oauth-entry-title" className="text-lg">{t('Connect Cloudflare', 'Mit Cloudflare verbinden')}</CardTitle>
                <CardDescription>
                  {t('Sign in directly with Cloudflare and grant Shelter the required access. Your Cloudflare password stays with Cloudflare.', 'Melde dich direkt bei Cloudflare an und erlaube Shelter den benötigten Zugriff. Dein Cloudflare-Passwort bleibt bei Cloudflare.')}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5">
                <ul className="grid gap-2 text-sm text-muted-foreground" aria-label={t('Required Cloudflare permissions', 'Benötigte Cloudflare-Bereiche')}>
                  {[t('Read accounts', 'Accounts lesen'), t('Manage tunnels', 'Tunnel verwalten'), t('Manage DNS records', 'DNS-Einträge verwalten')].map((permission) => (
                    <li className="flex items-center gap-2" key={permission}>
                      <Check className="size-4 text-foreground" aria-hidden="true" />
                      {permission}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col items-start gap-2.5">
                  <Button
                    type="button"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      if (!cloudflareBusy) startOAuth.mutate();
                    }}
                    loading={startOAuth.isPending}
                    disabled={!settings.data?.oauthAvailable || cloudflareBusy}
                  >
                    {!startOAuth.isPending && <Cloud fill="currentColor" aria-hidden="true" />}
                    {startOAuth.isPending ? t('Opening sign-in …', 'Anmeldung wird geöffnet …') : t('Connect Cloudflare', 'Mit Cloudflare verbinden')}
                    {!startOAuth.isPending && <ExternalLink aria-hidden="true" />}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t('You will be redirected to sign in with Cloudflare.', 'Du wirst zur Anmeldung bei Cloudflare weitergeleitet.')}</p>
                </div>
                {startOAuth.isError && (
                  <InlineNotice tone="error" title={t('Cloudflare sign-in could not be started', 'Cloudflare-Anmeldung konnte nicht gestartet werden')}>
                    {errorMessage(startOAuth.error, t('Please try again.', 'Bitte versuche es erneut.'))}
                  </InlineNotice>
                )}
              </CardContent>
            </Card>
          )}

          {!settings.data?.oauthAvailable && (
            <Alert role="note" className="items-start p-4">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{t('Configure the OAuth client on the server once', 'OAuth-Client einmalig auf dem Server einrichten')}</AlertTitle>
              <AlertDescription className="grid gap-3">
                <p>{t('Add the Cloudflare OAuth client ID and client secret to the server configuration. The secret is never entered or shown in the browser.', 'Hinterlege Client-ID und Client-Secret des Cloudflare-OAuth-Clients in der Serverkonfiguration. Das Secret wird nicht im Browser eingegeben oder angezeigt.')}</p>
                {settings.data?.oauthRedirectUri && (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('Callback URL', 'Callback-URL')}</span>
                    <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{settings.data.oauthRedirectUri}</code>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => void copyRedirectUri()} aria-label={t('Copy callback URL', 'Callback URL kopieren')}>
                      {redirectCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    </Button>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {settings.data && authorized && (oauthPending || (!configured && settings.data.authMethod !== 'api_token')) && (
            <Card>
              <form onSubmit={submitOAuthSetup}>
                <CardHeader className="border-b">
                  <SectionHeading
                    eyebrow={configured ? t('Renew connection', 'Verbindung erneuern') : t('Cloudflare authorized', 'Cloudflare autorisiert')}
                    title={configured ? t('Confirm new Cloudflare sign-in', 'Neue Cloudflare-Anmeldung bestätigen') : t('Set up tunnel', 'Tunnel einrichten')}
                    description={configured
                      ? t('Review the account and routing, then accept the newly authorized access.', 'Prüfe Account und Routing und übernimm anschließend den neu autorisierten Zugang.')
                      : t('Select the Cloudflare account and the hostname used to reach Shelter.', 'Wähle den Cloudflare-Account und lege fest, über welchen Hostnamen Shelter erreichbar wird.')}
                    action={<span className="flex items-center gap-1.5 text-sm text-muted-foreground"><Check className="size-4 text-success" aria-hidden="true" /> {t('Sign-in authorized', 'Anmeldung autorisiert')}</span>}
                  />
                </CardHeader>
                <CardContent className="grid gap-5 pt-4">
                  {settings.data.accounts.length > 1 ? (
                    <SelectField
                      label={t('Cloudflare account', 'Cloudflare-Konto')}
                      name="oauthAccountId"
                      value={form.accountId}
                      onChange={(event) => update('accountId', event.target.value)}
                      hint={t('The account where the tunnel and DNS routes are created', 'Der Account, in dem Tunnel und DNS-Routen angelegt werden')}
                      error={cloudflareTouched.accountId ? cloudflareErrors.accountId : undefined}
                      disabled={cloudflareBusy}
                      required
                    >
                      <option value="">{t('Select account', 'Account auswählen')}</option>
                      {settings.data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                    </SelectField>
                  ) : settings.data.accounts.length === 1 ? (
                    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-l-2 pl-3">
                      <Building2 size={17} className="text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{t('Cloudflare account', 'Cloudflare-Konto')}</span>
                        <strong className="mt-0.5 block truncate text-sm font-medium">{settings.data.accounts[0]?.name}</strong>
                        <code className="block truncate font-mono text-xs text-muted-foreground">{settings.data.accounts[0]?.id}</code>
                      </div>
                      <Check size={16} className="text-success" aria-label={t('Selected', 'Ausgewählt')} />
                    </div>
                  ) : (
                    <InlineNotice tone="warning" title={t('No Cloudflare account available', 'Kein Cloudflare Account verfügbar')}>
                      {t('Reconnect Cloudflare with a user who can access at least one account.', 'Verbinde Cloudflare erneut mit einem Benutzer, der Zugriff auf mindestens einen Account hat.')}
                    </InlineNotice>
                  )}
                  <div className="grid gap-4 md:grid-cols-2">
                    <Field label={t('Tunnel name', 'Tunnel-Name')} name="oauthTunnelName" value={form.tunnelName} onChange={(event) => update('tunnelName', event.target.value)} placeholder="shelter" hint={t('Created if it does not exist', 'Wird angelegt, falls er noch nicht existiert')} error={cloudflareTouched.tunnelName ? cloudflareErrors.tunnelName : undefined} disabled={cloudflareBusy} required />
                    <Field label={t('Panel domain', 'Panel-Domain')} name="oauthPanelDomain" value={form.panelDomain} onChange={(event) => update('panelDomain', event.target.value)} placeholder="panel.example.com" hint={t('Unused subdomain for this dashboard', 'Freie Subdomain für dieses Dashboard')} error={cloudflareTouched.panelDomain ? cloudflareErrors.panelDomain : undefined} disabled={cloudflareBusy} required />
                  </div>
                  {save.isError && save.variables === 'oauth' && (
                    <InlineNotice tone="error" title={t('Tunnel could not be configured', 'Tunnel konnte nicht eingerichtet werden')}>
                      {errorMessage(save.error, t('Cloudflare request failed.', 'Cloudflare-Anfrage fehlgeschlagen.'))}
                    </InlineNotice>
                  )}
                  <div className="flex justify-end">
                    <Button type="submit" loading={save.isPending && save.variables === 'oauth'} disabled={!canSaveOAuth || cloudflareBusy} className="w-full sm:w-auto">
                      {save.isPending && save.variables === 'oauth'
                        ? configured ? t('Applying sign-in …', 'Anmeldung wird übernommen …') : t('Setting up tunnel …', 'Tunnel wird eingerichtet …')
                        : configured ? t('Apply sign-in', 'Anmeldung übernehmen') : t('Set up tunnel', 'Tunnel einrichten')} {!save.isPending && <ArrowRight aria-hidden="true" />}
                    </Button>
                  </div>
                </CardContent>
              </form>
            </Card>
          )}

          {authorized && configured && !settings.data?.oauthPending && (
            <Card className="gap-0 py-0">
              <Accordion type="single" collapsible>
                <AccordionItem value="routing" className="border-0">
                  <AccordionTrigger className="px-5 py-4 hover:no-underline sm:px-6">
                    <span className="flex items-center gap-3 text-left">
                      <Network size={17} className="text-muted-foreground" aria-hidden="true" />
                      <span><strong className="block text-sm">{t('Change routing settings', 'Routing-Einstellungen ändern')}</strong><small className="block text-xs font-normal text-muted-foreground">{t('Update tunnel name and panel domain', 'Tunnel-Name und Panel-Domain aktualisieren')}</small></span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="px-5 pb-5 sm:px-6 sm:pb-6">
                    <Separator className="mb-5" />
                    <form className="grid gap-5" onSubmit={submitRouting}>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Field label={t('Tunnel name', 'Tunnel-Name')} name="connectedTunnelName" value={form.tunnelName} onChange={(event) => update('tunnelName', event.target.value)} placeholder="shelter" error={cloudflareTouched.tunnelName ? cloudflareErrors.tunnelName : undefined} disabled={cloudflareBusy} required />
                        <Field label={t('Panel domain', 'Panel-Domain')} name="connectedPanelDomain" value={form.panelDomain} onChange={(event) => update('panelDomain', event.target.value)} placeholder="panel.example.com" error={cloudflareTouched.panelDomain ? cloudflareErrors.panelDomain : undefined} disabled={cloudflareBusy} required />
                      </div>
                      {save.isSuccess && save.variables === 'routing' && (
                        <InlineNotice tone="success" title={t('Routing updated', 'Routing aktualisiert')}>
                          {t('Shelter updated the Cloudflare connection and panel routing.', 'Shelter hat die Cloudflare-Verbindung und das Panel-Routing aktualisiert.')}
                        </InlineNotice>
                      )}
                      {save.isError && save.variables === 'routing' && (
                        <InlineNotice tone="error" title={t('Routing could not be saved', 'Routing konnte nicht gespeichert werden')}>
                          {errorMessage(save.error, t('Cloudflare request failed.', 'Cloudflare-Anfrage fehlgeschlagen.'))}
                        </InlineNotice>
                      )}
                      <div className="flex justify-end">
                        <Button type="submit" loading={save.isPending && save.variables === 'routing'} disabled={!canSaveOAuth || cloudflareBusy} className="w-full sm:w-auto">
                          {save.isPending && save.variables === 'routing' ? t('Saving routing …', 'Routing wird gespeichert …') : t('Save routing', 'Routing speichern')}
                        </Button>
                      </div>
                    </form>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </Card>
          )}

          {panelAccessProtection?.panelDomain && (
            <CloudflareAccessProtectionCard
              accessProtection={panelAccessProtection}
              accountId={settings.data?.accountId}
              pending={confirmAccessProtection.isPending || revokeAccessProtection.isPending}
              error={confirmAccessProtection.error || revokeAccessProtection.error
                ? accessProtectionErrorMessage(confirmAccessProtection.error ?? revokeAccessProtection.error)
                : null}
              success={confirmAccessProtection.isSuccess
                ? 'confirmed'
                : revokeAccessProtection.isSuccess
                  ? 'revoked'
                  : null}
              onConfirm={() => {
                revokeAccessProtection.reset();
                confirmAccessProtection.mutate();
              }}
              onRevoke={() => {
                confirmAccessProtection.reset();
                revokeAccessProtection.mutate();
              }}
            />
          )}

          {(!configured || settings.data?.authMethod === 'api_token') && (
            <Card className="gap-0 py-0">
              <Accordion type="single" collapsible>
                <AccordionItem value="token" className="border-0">
                  <AccordionTrigger className="px-5 py-4 hover:no-underline sm:px-6">
                    <span className="flex items-center gap-3 text-left">
                      <KeyRound size={17} className="text-muted-foreground" aria-hidden="true" />
                      <span><strong className="block text-sm">{t('Manual connection', 'Manuelle Verbindung')}</strong><small className="block text-xs font-normal text-muted-foreground">{t('Fallback with a scoped API token', 'Fallback mit begrenztem API-Token')}</small></span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-5 pb-5 sm:px-6 sm:pb-6">
                  <Separator className="mb-5" />
                  <form className="grid gap-5" onSubmit={submitTokenFallback}>
                    <InlineNotice tone="warning" title={t('Use a minimally scoped token', 'Minimal berechtigten Token verwenden')}>
                      {t('Use this path only when OAuth is unavailable. Create a dedicated, minimally scoped token for Shelter.', 'Nutze diesen Weg nur, wenn OAuth nicht verfügbar ist. Erstelle einen eigenen, minimal berechtigten Token nur für Shelter.')}
                    </InlineNotice>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field
                        label={t('Account ID', 'Konto-ID')}
                        name="tokenAccountId"
                        value={form.accountId}
                        onChange={(event) => update('accountId', event.target.value)}
                        placeholder="023e105f4ecef8ad9ca31a8372d0c353"
                        error={cloudflareTouched.accountId ? cloudflareErrors.accountId : undefined}
                        disabled={cloudflareBusy}
                        required
                      />
                      <Field
                        label={t('API token', 'API-Token')}
                        name="apiToken"
                        type="password"
                        autoComplete="new-password"
                        value={form.apiToken}
                        onChange={(event) => update('apiToken', event.target.value)}
                        placeholder={settings.data?.hasApiToken ? t('••••••••••••  unchanged', '••••••••••••  unverändert') : t('Cloudflare API token', 'Cloudflare-API-Token')}
                        hint={settings.data?.hasApiToken ? t('Leave empty to keep the saved token', 'Leer lassen, um den gespeicherten Token zu behalten') : t('Stored encrypted on your VPS', 'Wird verschlüsselt auf deinem VPS gespeichert')}
                        disabled={cloudflareBusy}
                        required={!settings.data?.hasApiToken}
                      />
                      <Field label={t('Tunnel name', 'Tunnel-Name')} name="tokenTunnelName" value={form.tunnelName} onChange={(event) => update('tunnelName', event.target.value)} placeholder="shelter" error={cloudflareTouched.tunnelName ? cloudflareErrors.tunnelName : undefined} disabled={cloudflareBusy} required />
                      <Field label={t('Panel domain', 'Panel-Domain')} name="tokenPanelDomain" value={form.panelDomain} onChange={(event) => update('panelDomain', event.target.value)} placeholder="panel.example.com" error={cloudflareTouched.panelDomain ? cloudflareErrors.panelDomain : undefined} disabled={cloudflareBusy} required />
                    </div>
                    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                      <LockKeyhole size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {t('The token is never sent back to the browser after saving.', 'Der Token wird nach dem Speichern nie wieder an den Browser zurückgesendet.')}
                    </div>
                    {save.isSuccess && save.variables === 'api_token' && (
                      <InlineNotice tone="success" title={t('API token saved', 'API-Token gespeichert')}>
                        {t('Shelter updated the Cloudflare connection and panel routing.', 'Shelter hat die Cloudflare-Verbindung und das Panel-Routing aktualisiert.')}
                      </InlineNotice>
                    )}
                    {save.isError && save.variables === 'api_token' && (
                      <InlineNotice tone="error" title={t('API token could not be saved', 'API-Token konnte nicht gespeichert werden')}>
                        {errorMessage(save.error, t('Cloudflare request failed.', 'Cloudflare-Anfrage fehlgeschlagen.'))}
                      </InlineNotice>
                    )}
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Button variant="outline" asChild className="w-full sm:w-auto">
                        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">{t('Create token', 'Token erstellen')} <ExternalLink aria-hidden="true" /></a>
                      </Button>
                      <Button type="submit" loading={save.isPending && save.variables === 'api_token'} disabled={!canSaveToken || cloudflareBusy} className="w-full sm:w-auto">
                        {save.isPending && save.variables === 'api_token' ? t('Saving token …', 'Token wird gespeichert …') : t('Save token', 'Token speichern')}
                      </Button>
                    </div>
                  </form>
                </AccordionContent>
                </AccordionItem>
              </Accordion>
            </Card>
          )}
        </div>

        {!configured && <aside className="border-t pt-6 xl:sticky xl:top-8 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-6" aria-labelledby="cloudflare-help-title">
          <h2 id="cloudflare-help-title" className="text-base font-semibold">{t('How it works', 'So funktioniert es')}</h2>
          <ol className="mt-4 grid gap-4">
            {[
              ['1.', t('Sign in with Cloudflare', 'Bei Cloudflare anmelden'), t('You confirm access directly on Cloudflare.', 'Du bestätigst den Zugriff direkt auf der Cloudflare-Seite.')],
              ['2.', t('Choose account and hostname', 'Account und Hostname wählen'), t('Shelter lists available accounts and configures routing.', 'Shelter zeigt verfügbare Accounts an und richtet das Routing ein.')],
              ['3.', t('Use the tunnel', 'Tunnel verwenden'), t('The panel and projects remain reachable without a public VPS port.', 'Panel und Projekte bleiben ohne öffentlich offenen VPS-Port erreichbar.')],
              ['4.', t('Protect the panel with Access', 'Panel mit Access schützen'), t('Add a Self-hosted Access application for the panel hostname and confirm the checklist in Shelter.', 'Lege eine Self-hosted-Access-Anwendung für den Panel-Hostnamen an und bestätige anschließend die Checkliste in Shelter.')],
            ].map(([number, title, description]) => (
              <li key={number} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-sm">
                <span className="text-muted-foreground" aria-hidden="true">{number}</span>
                <div>
                  <strong className="font-medium">{title}</strong>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
                </div>
              </li>
            ))}
          </ol>

          <a
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-4"
            href="https://dash.cloudflare.com/?to=%2F%3Aaccount%2Foauth-clients"
            target="_blank"
            rel="noreferrer"
          >
            {t('Open OAuth clients', 'OAuth-Clients öffnen')} <ExternalLink className="size-4" aria-hidden="true" />
          </a>

          <Separator className="my-5" />

          <div className="flex items-start gap-2.5 text-xs leading-5 text-muted-foreground">
            <KeyRound size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p><strong className="font-medium text-foreground">{t('No Cloudflare password in Shelter.', 'Kein Cloudflare-Passwort in Shelter.')}</strong> {t('Authorization and consent happen exclusively on Cloudflare.', 'Autorisierung und Zustimmung erfolgen ausschließlich bei Cloudflare.')}</p>
          </div>
          {settings.data?.oauthExpiresAt && (
            <div className="mt-4 flex items-start gap-2.5 text-xs text-muted-foreground">
              <CalendarClock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>{t('OAuth expiry', 'OAuth-Ablauf')}<br /><strong className="font-medium text-foreground">{oauthExpiry || t('Managed by Cloudflare', 'Von Cloudflare verwaltet')}</strong></p>
            </div>
          )}
        </aside>}
      </section>

      {configured && (
        <section aria-labelledby="cloudflare-danger-title" className="max-w-4xl">
          <Card className="border-destructive/20">
            <CardHeader>
              <CardTitle id="cloudflare-danger-title" className="text-base">{t('Remove Cloudflare authorization', 'Cloudflare-Autorisierung entfernen')}</CardTitle>
              <CardDescription>
                {t('Removes credentials from Shelter. Existing tunnels and connectors continue to run in Cloudflare until you delete them there.', 'Entfernt die Zugangsdaten aus Shelter. Bestehende Tunnel und Connectoren laufen bei Cloudflare weiter, bis du sie dort löschst.')}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {disconnect.isError && (
                <InlineNotice tone="error" title={t('Cloudflare connection could not be disconnected', 'Cloudflare-Verbindung konnte nicht getrennt werden')}>
                  {errorMessage(disconnect.error, t('Please try again.', 'Bitte versuche es erneut.'))}
                </InlineNotice>
              )}
              <div className="flex justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="danger" loading={disconnect.isPending} disabled={cloudflareBusy} className="w-full sm:w-auto">
                      {!disconnect.isPending && <Unplug aria-hidden="true" />} {disconnect.isPending ? t('Disconnecting …', 'Verbindung wird getrennt …') : t('Remove Cloudflare authorization', 'Cloudflare-Autorisierung entfernen')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogMedia className="bg-destructive/10 text-destructive">
                        <Unplug aria-hidden="true" />
                      </AlertDialogMedia>
                      <AlertDialogTitle>{t('Remove Cloudflare authorization from Shelter?', 'Cloudflare-Autorisierung aus Shelter entfernen?')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('Existing tunnels and cloudflared connectors continue to run in Cloudflare until you delete them there.', 'Bestehende Tunnel und cloudflared-Connectoren laufen bei Cloudflare weiter, bis du sie dort löschst.')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        disabled={cloudflareBusy}
                        onClick={() => {
                          if (!cloudflareBusy) disconnect.mutate();
                        }}
                      >
                        {t('Remove authorization', 'Autorisierung entfernen')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </CardContent>
          </Card>
        </section>
      )}
      </div>
    </>
  );
}
