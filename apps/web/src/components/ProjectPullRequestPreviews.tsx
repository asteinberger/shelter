import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clock3,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Layers3,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api/client';
import type {
  EnvironmentVariable,
  GitHubPreviewCapability,
  Project,
  PullRequestPreview,
  PullRequestPreviewsResponse,
  PullRequestPreviewStatus,
} from '../types';
import { formatDate, formatRelative } from '../utils/format';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button, ErrorState, Field, SelectField, Skeleton, StatusBadge } from './ui';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
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
} from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { GitHubPreviewCapabilityNotice } from './GitHubPreviewCapabilityNotice';

export { GitHubPreviewCapabilityNotice as PreviewCapability } from './GitHubPreviewCapabilityNotice';

const transitionalPreviewStates = new Set<PullRequestPreviewStatus>(['queued', 'building', 'closing']);
const activePreviewStates = new Set<PullRequestPreviewStatus>(['queued', 'building', 'ready']);
const reservedEnvironmentKeys = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);
const MAX_ENVIRONMENT_VARIABLES = 200;
const MAX_ENVIRONMENT_KEY_LENGTH = 100;
const MAX_ENVIRONMENT_VALUE_LENGTH = 65_536;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const utf8Encoder = new TextEncoder();

export function isTransitionalPullRequestPreview(status: PullRequestPreviewStatus) {
  return transitionalPreviewStates.has(status);
}

export function trustedPullRequestPreviewUrl(preview: Pick<PullRequestPreview, 'hostname' | 'status' | 'activeDeploymentId'>) {
  if (!preview.activeDeploymentId || ['closing', 'closed', 'blocked'].includes(preview.status)) return undefined;
  const hostname = preview.hostname.trim().toLowerCase();
  const validLabels = hostname.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ));
  if (
    hostname.length > 253
    || !hostname.includes('.')
    || hostname.includes('..')
    || !validLabels
  ) return undefined;
  return `https://${hostname}`;
}

export function previewEnvironmentValidation(
  environment: EnvironmentVariable[],
  knownKeys: string[],
  t: (english: string, german: string, values?: Record<string, string | number>) => string,
) {
  const known = new Set(knownKeys);
  const keys = environment.map((variable) => variable.key.trim());
  const errors = environment.map((variable, index) => {
    const key = variable.key.trim();
    if (!key) return t('The variable name is missing.', 'Der Variablenname fehlt.');
    if (key.length > MAX_ENVIRONMENT_KEY_LENGTH) {
      return t('The variable name may contain at most {count} characters.', 'Der Variablenname darf höchstens {count} Zeichen lang sein.', { count: MAX_ENVIRONMENT_KEY_LENGTH });
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return t('Begin with a letter or underscore; A–Z, 0–9, and _ are allowed.', 'Beginne mit Buchstabe oder Unterstrich; erlaubt sind A–Z, 0–9 und _.');
    }
    if (reservedEnvironmentKeys.has(key)) return t('{key} is managed by Shelter.', '{key} wird von Shelter verwaltet.', { key });
    if (keys.indexOf(key) !== keys.lastIndexOf(key)) return t('This variable name occurs more than once.', 'Dieser Variablenname ist doppelt vorhanden.');
    if ((variable.value?.length ?? 0) > MAX_ENVIRONMENT_VALUE_LENGTH) {
      return t('The value may contain at most 65,536 characters.', 'Der Wert darf höchstens 65.536 Zeichen lang sein.');
    }
    if (!known.has(key) && (variable.value === undefined || variable.value === '')) {
      return t('A value is required for a new variable.', 'Für eine neue Variable ist ein Wert erforderlich.');
    }
    return undefined;
  });
  const bytes = environment.reduce((total, variable) => (
    total
    + utf8Encoder.encode(variable.key).byteLength
    + utf8Encoder.encode(variable.value ?? '').byteLength
    + 2
  ), 0);
  const globalError = environment.length > MAX_ENVIRONMENT_VARIABLES
    ? t('At most {count} variables are allowed.', 'Es sind höchstens {count} Variablen erlaubt.', { count: MAX_ENVIRONMENT_VARIABLES })
    : bytes > MAX_ENVIRONMENT_BYTES
      ? t('The entered variables may total at most 256 KiB.', 'Die eingegebenen Variablen dürfen zusammen höchstens 256 KiB groß sein.')
      : undefined;
  return { errors, globalError, valid: errors.every((error) => !error) && !globalError };
}

function capabilityStatus(capability?: GitHubPreviewCapability) {
  if (!capability) return 'pending';
  return capability.ready ? 'ready' : 'failed';
}

function SafetyRail({ maxActive }: { maxActive: number }) {
  const { t } = useI18n();
  const items = [
    { icon: Layers3, title: t('{count} at a time', '{count} gleichzeitig', { count: maxActive }), body: t('A hard per-project limit', 'Festes Limit pro Projekt') },
    { icon: GitBranch, title: t('Same repository only', 'Nur dasselbe Repository'), body: t('Fork pull requests are rejected', 'Fork-Pull-Requests werden abgelehnt') },
    { icon: KeyRound, title: t('Isolated variables', 'Isolierte Variablen'), body: t('Production secrets are never inherited', 'Produktions-Secrets werden nie übernommen') },
  ];
  return (
    <div className="grid overflow-hidden rounded-lg border bg-muted/15 sm:grid-cols-3" aria-label={t('Preview safety boundaries', 'Sicherheitsgrenzen für Previews')}>
      {items.map(({ icon: Icon, title, body }, index) => (
        <div className={cn('flex items-start gap-3 p-4', index > 0 && 'border-t sm:border-t-0 sm:border-l')} key={title}>
          <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background"><Icon className="size-4 text-muted-foreground" aria-hidden="true" /></span>
          <div className="min-w-0"><p className="text-sm font-medium">{title}</p><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{body}</p></div>
        </div>
      ))}
    </div>
  );
}

function PreviewStatusBadge({ status, rebuilding }: { status: PullRequestPreviewStatus; rebuilding: boolean }) {
  const { t } = useI18n();
  if (rebuilding) return <StatusBadge status="building" />;
  if (status === 'closing') return <StatusBadge status="pending" className="[&>span]:bg-warning" />;
  if (status === 'closed') return <Badge variant="outline">{t('Closed', 'Geschlossen')}</Badge>;
  if (status === 'blocked') return <Badge variant="destructive">{t('Blocked', 'Blockiert')}</Badge>;
  return <StatusBadge status={status} />;
}

export function PullRequestPreviewList({
  projectId,
  previews,
  maxActive,
  closingId,
  highlightedId,
  onClose,
}: {
  projectId: string;
  previews: PullRequestPreview[];
  maxActive: number;
  closingId?: string;
  highlightedId?: string | null;
  onClose: (preview: PullRequestPreview) => void;
}) {
  const { t, locale } = useI18n();
  const activeCount = previews.filter((preview) => (
    Boolean(preview.activeDeploymentId) || activePreviewStates.has(preview.status)
  )).length;
  if (previews.length === 0) {
    return (
      <Empty className="min-h-64 border-0">
        <EmptyMedia variant="icon"><GitPullRequest /></EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t('No pull request previews yet', 'Noch keine Pull-Request-Previews')}</EmptyTitle>
          <EmptyDescription>{t('Open a pull request from a branch in this repository. Shelter will show its isolated preview here.', 'Öffne einen Pull Request aus einem Branch dieses Repositories. Shelter zeigt die isolierte Preview dann hier an.')}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent><Badge variant="outline">{t('Forks stay blocked', 'Forks bleiben blockiert')}</Badge></EmptyContent>
      </Empty>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span>{t('{count} active of {max}', '{count} von {max} aktiv', { count: activeCount, max: maxActive })}</span>
        <span>{t('Newest activity first', 'Neueste Aktivität zuerst')}</span>
      </div>
      {activeCount >= maxActive && (
        <Alert>
          <Layers3 aria-hidden="true" />
          <AlertTitle>{t('Active preview limit reached', 'Limit aktiver Previews erreicht')}</AlertTitle>
          <AlertDescription>{t('New pull requests stay blocked until one of the {count} active previews is closed.', 'Neue Pull Requests bleiben blockiert, bis eine der {count} aktiven Previews geschlossen wird.', { count: maxActive })}</AlertDescription>
        </Alert>
      )}
      <ol className="grid gap-2">
        {previews.map((preview) => {
          const rebuilding = preview.generation > 1 && ['queued', 'building'].includes(preview.status);
          const url = trustedPullRequestPreviewUrl(preview);
          const canClose = !['closed', 'closing'].includes(preview.status);
          return (
            <li
              id={`pull-request-preview-${preview.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
              className={cn('scroll-mt-24 rounded-lg border bg-background p-4 transition-all hover:border-foreground/20', highlightedId === preview.id && 'border-info/45 ring-3 ring-info/10')}
              aria-current={highlightedId === preview.id ? 'true' : undefined}
              key={preview.id}
            >
              <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 font-semibold"><GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" /> #{preview.pullRequestNumber}</span>
                    <PreviewStatusBadge status={preview.status} rebuilding={rebuilding} />
                    {highlightedId === preview.id && <Badge variant="outline">{t('Linked from GitHub', 'Von GitHub verlinkt')}</Badge>}
                    {rebuilding && <Badge variant="secondary">{t('Rebuild {generation}', 'Neu-Build {generation}', { generation: preview.generation })}</Badge>}
                    {!rebuilding && preview.generation > 1 && <Badge variant="outline">{t('Generation {generation}', 'Generation {generation}', { generation: preview.generation })}</Badge>}
                  </div>
                  <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono">{preview.headRef}</code>
                    <span className="text-muted-foreground" aria-hidden="true">→</span>
                    <code className="max-w-full truncate font-mono text-muted-foreground">{preview.baseRef}</code>
                    <span className="text-muted-foreground" aria-hidden="true">·</span>
                    <code className="font-mono text-xs text-muted-foreground">{preview.headSha.slice(0, 8)}</code>
                  </div>
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5"><Clock3 className="size-3.5" aria-hidden="true" /><dt className="sr-only">{t('Updated', 'Aktualisiert')}</dt><dd>{t('Updated {time}', 'Aktualisiert {time}', { time: formatRelative(preview.updatedAt, locale) })}</dd></div>
                    <div><dt className="sr-only">{t('Expires', 'Läuft ab')}</dt><dd>{preview.status === 'closed' ? t('Closed {time}', 'Geschlossen {time}', { time: formatRelative(preview.closedAt ?? preview.updatedAt, locale) }) : <time dateTime={preview.expiresAt} title={formatDate(preview.expiresAt, locale)}>{t('Expires {time}', 'Läuft {time} ab', { time: formatRelative(preview.expiresAt, locale) })}</time>}</dd></div>
                  </dl>
                  {(preview.error || preview.status === 'failed' || preview.status === 'blocked') && (
                    <div className="mt-3 rounded-md bg-destructive/8 px-3 py-2 text-xs leading-relaxed text-destructive" role="alert">
                      <p>{preview.error ?? t('The preview could not be created.', 'Die Preview konnte nicht erstellt werden.')}</p>
                      {preview.activeDeploymentId && preview.status === 'failed' && (
                        <p className="mt-1 text-muted-foreground">{t('The last successful preview stays online.', 'Die letzte erfolgreiche Preview bleibt online.')}</p>
                      )}
                    </div>
                  )}
                  {url && (
                    <a className="mt-3 block truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" href={url} target="_blank" rel="noreferrer">{preview.hostname}</a>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  {preview.deploymentId && (
                    <Button asChild variant="outline" size="sm"><Link to={`/projects/${projectId}/deployments/${preview.deploymentId}`}>{t('Build details & logs', 'Build-Details & Logs')}</Link></Button>
                  )}
                  {url && <Button asChild size="sm"><a href={url} target="_blank" rel="noreferrer">{t('Open preview', 'Preview öffnen')} <ExternalLink /></a></Button>}
                  {canClose && (
                    <Button variant="ghost" size="sm" disabled={closingId === preview.id} onClick={() => onClose(preview)}>
                      {closingId === preview.id ? <LoaderCircle className="animate-spin" /> : <Trash2 />}{t('Close', 'Schließen')}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function ProjectPullRequestPreviews({
  project,
  active,
  highlightedPreviewId,
  onDirtyChange,
  onProjectChanged,
}: {
  project: Project;
  active: boolean;
  highlightedPreviewId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onProjectChanged?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [domainId, setDomainId] = useState('');
  const [ttlHours, setTtlHours] = useState('72');
  const [environment, setEnvironment] = useState<EnvironmentVariable[]>([]);
  const [environmentRemovalIndex, setEnvironmentRemovalIndex] = useState<number>();
  const [previewToClose, setPreviewToClose] = useState<PullRequestPreview>();
  const settingsSignature = useRef('');
  const environmentSignature = useRef('');

  const previewsQuery = useQuery({
    queryKey: ['project-pull-request-previews', project.id],
    queryFn: () => api.projectPullRequestPreviews(project.id),
    enabled: active,
    retry: false,
    refetchInterval: (query) => !active
      ? false
      : query.state.data?.previews.some((preview) => isTransitionalPullRequestPreview(preview.status)) ? 3_000 : 15_000,
  });
  const githubInstallationId = project.github?.installationId ?? project.githubInstallationId;
  const capabilityQuery = useQuery({
    queryKey: ['github-preview-capability', githubInstallationId],
    queryFn: () => api.githubPreviewCapability(githubInstallationId!),
    enabled: active && githubInstallationId !== undefined && githubInstallationId !== null,
    retry: false,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: (query) => query.state.data?.ready === false ? 'always' : false,
    refetchOnReconnect: (query) => query.state.data?.ready === false ? 'always' : false,
  });
  const data = previewsQuery.data;
  const capability = capabilityQuery.data;
  const activeDomains = (project.domains ?? []).filter((domain) => domain.status === 'active');
  const savedSettings = data?.settings;
  const savedEnvironmentKeys = data?.environmentKeys ?? [];
  const highlightedPreviewExists = Boolean(highlightedPreviewId && data?.previews.some((preview) => preview.id === highlightedPreviewId));

  useEffect(() => {
    if (!savedSettings) return;
    const signature = `${savedSettings.enabled}:${savedSettings.domainId ?? ''}:${savedSettings.ttlHours}`;
    if (settingsSignature.current === signature) return;
    settingsSignature.current = signature;
    setEnabled(savedSettings.enabled);
    setDomainId(savedSettings.domainId ?? '');
    setTtlHours(String(savedSettings.ttlHours));
  }, [savedSettings]);

  useEffect(() => {
    if (!data) return;
    const signature = data.environmentKeys.join('|');
    if (environmentSignature.current === signature) return;
    environmentSignature.current = signature;
    setEnvironment(data.environmentKeys.map((key) => ({ key, value: undefined })));
  }, [data]);

  useEffect(() => {
    if (!active || !highlightedPreviewId || !highlightedPreviewExists) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`pull-request-preview-${highlightedPreviewId.replace(/[^a-zA-Z0-9_-]/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, highlightedPreviewExists, highlightedPreviewId]);

  const parsedTtl = Number(ttlHours);
  const ttlError = !Number.isInteger(parsedTtl) || parsedTtl < 1 || parsedTtl > 168
    ? t('Choose a whole number from 1 to 168 hours.', 'Wähle eine ganze Zahl zwischen 1 und 168 Stunden.')
    : undefined;
  const selectedDomainActive = activeDomains.some((domain) => domain.id === domainId);
  const domainError = enabled && !domainId
    ? t('Choose an active project domain.', 'Wähle eine aktive Projekt-Domain.')
    : enabled && !selectedDomainActive
      ? t('The selected domain is no longer active.', 'Die ausgewählte Domain ist nicht mehr aktiv.')
      : undefined;
  const settingsDirty = savedSettings ? (
    enabled !== savedSettings.enabled
    || domainId !== (savedSettings.domainId ?? '')
    || ttlHours !== String(savedSettings.ttlHours)
  ) : false;
  const environmentDirty = Boolean(data) && (
    environment.length !== savedEnvironmentKeys.length
    || environment.some((variable, index) => variable.key !== savedEnvironmentKeys[index] || variable.value !== undefined)
  );
  const environmentValidation = useMemo(() => (
    previewEnvironmentValidation(environment, savedEnvironmentKeys, t)
  ), [environment, savedEnvironmentKeys, t]);

  useEffect(() => {
    onDirtyChange?.(settingsDirty || environmentDirty);
    return () => onDirtyChange?.(false);
  }, [environmentDirty, onDirtyChange, settingsDirty]);

  const saveSettings = useMutation({
    mutationFn: () => api.updateProjectPullRequestPreviewSettings(project.id, {
      enabled,
      domainId: enabled ? domainId : undefined,
      ttlHours: parsedTtl,
    }),
    onSuccess: (settings) => {
      queryClient.setQueryData<PullRequestPreviewsResponse>(['project-pull-request-previews', project.id], (current) => current ? ({
        ...current,
        settings: {
          ...current.settings,
          enabled: settings.enabled,
          domainId: settings.domainId,
          domainSuffix: settings.domainSuffix,
          ttlHours: settings.ttlHours,
        },
      }) : current);
      settingsSignature.current = `${settings.enabled}:${settings.domainId ?? ''}:${settings.ttlHours}`;
      setEnabled(settings.enabled);
      setDomainId(settings.domainId ?? '');
      setTtlHours(String(settings.ttlHours));
      onProjectChanged?.();
      toast.success(settings.enabled ? t('Pull request previews enabled', 'Pull-Request-Previews aktiviert') : t('Pull request previews disabled', 'Pull-Request-Previews deaktiviert'), {
        description: settings.enabled
          ? t('New same-repository pull requests can now create isolated previews.', 'Neue Pull Requests aus demselben Repository können jetzt isolierte Previews erstellen.')
          : t('Active previews are being closed safely.', 'Aktive Previews werden sicher geschlossen.'),
      });
    },
    onError: (error) => toast.error(t('Preview settings could not be saved', 'Preview-Einstellungen konnten nicht gespeichert werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  const saveEnvironment = useMutation({
    mutationFn: () => api.updateProjectPullRequestPreviewEnvironment(
      project.id,
      environment.map(({ key, value }) => ({ key: key.trim(), value: value === '' ? undefined : value })).filter(({ key }) => Boolean(key)),
    ),
    onSuccess: (response) => {
      queryClient.setQueryData<PullRequestPreviewsResponse>(['project-pull-request-previews', project.id], (current) => current ? ({ ...current, environmentKeys: response.environmentKeys }) : current);
      environmentSignature.current = response.environmentKeys.join('|');
      setEnvironment(response.environmentKeys.map((key) => ({ key, value: undefined })));
      toast.success(t('Preview environment saved', 'Preview-Umgebung gespeichert'), {
        description: t('Stored values stay hidden and apply only to future preview builds.', 'Gespeicherte Werte bleiben verborgen und gelten nur für zukünftige Preview-Builds.'),
      });
    },
    onError: (error) => toast.error(t('Preview environment could not be saved', 'Preview-Umgebung konnte nicht gespeichert werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  const closePreview = useMutation({
    mutationFn: (preview: PullRequestPreview) => api.closeProjectPullRequestPreview(project.id, preview.id),
    onSuccess: ({ preview }) => {
      queryClient.setQueryData<PullRequestPreviewsResponse>(['project-pull-request-previews', project.id], (current) => current ? ({
        ...current,
        previews: current.previews.map((candidate) => candidate.id === preview.id ? preview : candidate),
      }) : current);
      setPreviewToClose(undefined);
      toast.success(t('Preview cleanup started', 'Preview-Cleanup gestartet'), { description: `#${preview.pullRequestNumber}` });
    },
    onError: (error) => toast.error(t('Preview could not be closed', 'Preview konnte nicht geschlossen werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  if (previewsQuery.isLoading) {
    return (
      <div className="grid gap-5" role="status" aria-label={t('Loading pull request previews', 'Pull-Request-Previews werden geladen')}>
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
        <Skeleton className="h-56" />
      </div>
    );
  }
  if (previewsQuery.isError || !data) {
    return <ErrorState title={t('Pull request previews could not be loaded', 'Pull-Request-Previews konnten nicht geladen werden')} message={previewsQuery.error instanceof Error ? previewsQuery.error.message : undefined} action={<Button onClick={() => previewsQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>} />;
  }

  const currentSettings = data.settings;
  const canEnable = Boolean(project.github && !project.githubConnectionError && capability?.ready && activeDomains.length > 0);
  const configurationValid = !ttlError && (!enabled || (canEnable && !domainError));
  const missingCurrentDomain = currentSettings.domainId && !activeDomains.some((domain) => domain.id === currentSettings.domainId);

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span className="text-sm font-medium text-muted-foreground">GitHub</span>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{t('Pull request previews', 'Pull-Request-Previews')}</h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t('Review an isolated version of a branch before it reaches production.', 'Prüfe eine isolierte Version eines Branches, bevor sie die Produktion erreicht.')}</p>
        </div>
        <StatusBadge status={data.settings.enabled ? capabilityStatus(capability) : 'stopped'} />
      </div>

      <SafetyRail maxActive={data.settings.maxActive} />

      <Card aria-labelledby="preview-configuration-title">
        <CardHeader className="gap-4 border-b sm:grid-cols-[1fr_auto]">
          <div>
            <CardTitle id="preview-configuration-title" className="flex items-center gap-2"><GitPullRequest className="size-5" aria-hidden="true" /> {t('Preview automation', 'Preview-Automatisierung')}</CardTitle>
            <CardDescription className="mt-1">{t('Explicit opt-in for this project. Production stays untouched.', 'Explizites Opt-in für dieses Projekt. Die Produktion bleibt unberührt.')}</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="pull-request-previews-enabled" className="text-sm">{enabled ? t('Enabled', 'Aktiviert') : t('Disabled', 'Deaktiviert')}</Label>
            <Switch
              id="pull-request-previews-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saveSettings.isPending || (!enabled && !canEnable)}
              aria-describedby="pull-request-previews-enabled-description"
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          <GitHubPreviewCapabilityNotice capability={capability} refreshing={capabilityQuery.isFetching} onRetry={() => capabilityQuery.refetch()} />

          {!project.github && (
            <Alert>
              <GitBranch aria-hidden="true" />
              <AlertTitle>{t('This project is not connected through the GitHub App', 'Dieses Projekt ist nicht über die GitHub App verbunden')}</AlertTitle>
              <AlertDescription>{t('Connect the repository in project settings. Generic HTTPS repositories cannot receive trusted pull_request webhooks.', 'Verbinde das Repository in den Projekteinstellungen. Generische HTTPS-Repositories können keine vertrauenswürdigen pull_request-Webhooks empfangen.')}</AlertDescription>
              <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit"><Link to={`/projects/${project.id}?tab=settings`}>{t('Review project settings', 'Projekteinstellungen prüfen')}</Link></Button>
            </Alert>
          )}

          {project.githubConnectionError && (
            <Alert variant="destructive">
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{t('Repository access is interrupted', 'Repository-Zugriff ist unterbrochen')}</AlertTitle>
              <AlertDescription>{project.githubConnectionError}</AlertDescription>
              <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit"><Link to={`/projects/${project.id}?tab=settings`}>{t('Repair GitHub connection', 'GitHub-Verbindung reparieren')}</Link></Button>
            </Alert>
          )}

          {activeDomains.length === 0 && (
            <Alert>
              <AlertTriangle aria-hidden="true" />
              <AlertTitle>{t('An active project domain is required', 'Eine aktive Projekt-Domain ist erforderlich')}</AlertTitle>
              <AlertDescription>{t('Connect a domain first. Shelter uses its Cloudflare zone for short, one-level preview hostnames.', 'Verbinde zuerst eine Domain. Shelter nutzt ihre Cloudflare-Zone für kurze, einstufige Preview-Hostnames.')}</AlertDescription>
              <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit"><Link to={`/projects/${project.id}?tab=domains`}>{t('Connect domain', 'Domain verbinden')}</Link></Button>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <SelectField
              label={t('Cloudflare domain / zone', 'Cloudflare-Domain / Zone')}
              value={domainId}
              onChange={(event) => setDomainId(event.target.value)}
              disabled={!enabled || saveSettings.isPending}
              error={domainError}
              hint={currentSettings.domainSuffix
                ? t('Preview hostnames are created directly below {zone}.', 'Preview-Hostnames werden direkt unter {zone} erstellt.', { zone: currentSettings.domainSuffix })
                : t('Shelter resolves and verifies the connected Cloudflare zone when you save.', 'Shelter ermittelt und prüft beim Speichern die verbundene Cloudflare-Zone.')}
            >
              <option value="">{t('Select an active domain', 'Aktive Domain auswählen')}</option>
              {missingCurrentDomain && <option value={currentSettings.domainId ?? ''} disabled>{t('Previously selected domain (inactive)', 'Zuvor gewählte Domain (inaktiv)')}</option>}
              {activeDomains.map((domain) => <option value={domain.id} key={domain.id}>{domain.hostname}</option>)}
            </SelectField>
            <Field
              id="pull-request-preview-ttl"
              label={t('Lifetime in hours', 'Laufzeit in Stunden')}
              type="number"
              min={1}
              max={168}
              step={1}
              inputMode="numeric"
              value={ttlHours}
              onChange={(event) => setTtlHours(event.target.value)}
              disabled={saveSettings.isPending}
              error={ttlError}
              hint={t('1–168 hours', '1–168 Stunden')}
            />
          </div>

          {data.settings.enabled && data.settings.domainSuffix && (
            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-4 text-sm">
              <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-background"><GitPullRequest className="size-4 text-muted-foreground" aria-hidden="true" /></span>
              <p className="leading-relaxed text-muted-foreground"><strong className="font-medium text-foreground">{t('Active route pattern:', 'Aktives Routenmuster:')}</strong>{' '}<code className="break-all font-mono">pr-&lt;number&gt;--&lt;project&gt;.{data.settings.domainSuffix}</code></p>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-3 sm:flex-row sm:justify-between">
          <p id="pull-request-previews-enabled-description" className="text-xs leading-relaxed text-muted-foreground">{enabled
            ? t('Only new or updated same-repository pull requests trigger builds.', 'Nur neue oder aktualisierte Pull Requests aus demselben Repository starten Builds.')
            : t('No pull request can start a preview build while this is disabled.', 'Solange dies deaktiviert ist, kann kein Pull Request einen Preview-Build starten.')}</p>
          <Button onClick={() => saveSettings.mutate()} loading={saveSettings.isPending} disabled={!settingsDirty || !configurationValid} className="w-full sm:w-auto">{t('Save automation', 'Automatisierung speichern')}</Button>
        </CardFooter>
      </Card>

      <Card aria-labelledby="preview-environment-title">
        <CardHeader className="border-b">
          <div>
            <CardTitle id="preview-environment-title" className="flex items-center gap-2"><KeyRound className="size-5" aria-hidden="true" /> {t('Preview-only environment', 'Eigene Preview-Umgebung')}</CardTitle>
            <CardDescription className="mt-1">{t('Stored values are never returned to the browser and are never copied from production.', 'Gespeicherte Werte werden nie an den Browser zurückgegeben und nie aus der Produktion kopiert.')}</CardDescription>
          </div>
          <CardAction><Badge variant="outline">{t('{count} keys', '{count} Keys', { count: environment.length })}</Badge></CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>{t('Production environment is not inherited', 'Produktionsumgebung wird nicht übernommen')}</AlertTitle>
            <AlertDescription>{t('Add only the minimum test credentials a preview needs. Existing values stay masked; entering a value replaces it.', 'Füge nur die minimal nötigen Testzugänge hinzu. Bestehende Werte bleiben maskiert; eine Eingabe ersetzt den Wert.')}</AlertDescription>
          </Alert>
          {environment.length > 0 ? environment.map((variable, index) => (
            <div className="grid min-w-0 gap-3 rounded-lg border bg-muted/10 p-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] sm:items-start" key={`${index}-${savedEnvironmentKeys[index] ?? 'new'}`}>
              <div className="grid gap-2">
                <Label htmlFor={`preview-environment-key-${index}`}>{t('Variable', 'Variable')}</Label>
                <Input
                  id={`preview-environment-key-${index}`}
                  className="h-9 font-mono"
                  value={variable.key}
                  onChange={(event) => setEnvironment((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, key: event.target.value } : candidate))}
                  aria-invalid={Boolean(environmentValidation.errors[index]) || undefined}
                  aria-describedby={environmentValidation.errors[index] ? `preview-environment-error-${index}` : undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`preview-environment-value-${index}`}>{t('New value', 'Neuer Wert')}</Label>
                <Input
                  id={`preview-environment-value-${index}`}
                  className="h-9 font-mono"
                  type="password"
                  autoComplete="new-password"
                  value={variable.value ?? ''}
                  placeholder={savedEnvironmentKeys.includes(variable.key) ? t('••••••••  unchanged', '••••••••  unverändert') : t('Enter preview secret', 'Preview-Secret eingeben')}
                  onChange={(event) => setEnvironment((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, value: event.target.value } : candidate))}
                  aria-invalid={Boolean(environmentValidation.errors[index]) || undefined}
                  aria-describedby={environmentValidation.errors[index] ? `preview-environment-error-${index}` : undefined}
                  spellCheck={false}
                />
                {environmentValidation.errors[index] && <p id={`preview-environment-error-${index}`} className="text-xs text-destructive" role="alert">{environmentValidation.errors[index]}</p>}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="self-end text-muted-foreground hover:text-destructive"
                aria-label={t('Remove variable {key}', 'Variable {key} entfernen', { key: variable.key || index + 1 })}
                onClick={() => savedEnvironmentKeys.includes(variable.key) ? setEnvironmentRemovalIndex(index) : setEnvironment((current) => current.filter((_, candidateIndex) => candidateIndex !== index))}
              ><Trash2 /></Button>
            </div>
          )) : (
            <div className="rounded-lg border border-dashed px-5 py-8 text-center">
              <KeyRound className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">{t('No preview variables', 'Keine Preview-Variablen')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('This is the safest default.', 'Das ist die sicherste Voreinstellung.')}</p>
            </div>
          )}
          {environmentValidation.globalError && <p className="text-sm text-destructive" role="alert">{environmentValidation.globalError}</p>}
          <Button variant="outline" className="w-fit" disabled={environment.length >= MAX_ENVIRONMENT_VARIABLES || saveEnvironment.isPending} onClick={() => setEnvironment((current) => [...current, { key: '', value: '' }])}><Plus /> {t('Add variable', 'Variable hinzufügen')}</Button>
        </CardContent>
        <CardFooter className="flex-col gap-3 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground">{t('Changes apply to the next preview build, not to an already running preview.', 'Änderungen gelten für den nächsten Preview-Build, nicht für eine bereits laufende Preview.')}</p>
          <Button onClick={() => saveEnvironment.mutate()} loading={saveEnvironment.isPending} disabled={!environmentDirty || !environmentValidation.valid} className="w-full sm:w-auto">{t('Save preview environment', 'Preview-Umgebung speichern')}</Button>
        </CardFooter>
      </Card>

      <Card aria-labelledby="preview-history-title">
        <CardHeader className="border-b">
          <div><CardTitle id="preview-history-title">{t('Preview activity', 'Preview-Aktivität')}</CardTitle><CardDescription className="mt-1">{t('Builds, updates, expiry, and cleanup for this project.', 'Builds, Aktualisierungen, Ablauf und Cleanup für dieses Projekt.')}</CardDescription></div>
          <CardAction>{previewsQuery.isFetching && !previewsQuery.isLoading ? <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label={t('Refreshing', 'Wird aktualisiert')} /> : <Badge variant="secondary">{data.previews.length}</Badge>}</CardAction>
        </CardHeader>
        <CardContent className="p-2 sm:p-3">
          {!data.settings.enabled && data.previews.length === 0 ? (
            <Empty className="min-h-52 border-0">
              <EmptyMedia variant="icon"><GitPullRequest /></EmptyMedia>
              <EmptyHeader><EmptyTitle>{t('Previews are off', 'Previews sind aus')}</EmptyTitle><EmptyDescription>{t('Enable the opt-in above when this project is ready for pull request previews.', 'Aktiviere oben das Opt-in, sobald dieses Projekt für Pull-Request-Previews bereit ist.')}</EmptyDescription></EmptyHeader>
            </Empty>
          ) : (
            <PullRequestPreviewList projectId={project.id} previews={data.previews} maxActive={data.settings.maxActive} closingId={closePreview.isPending ? previewToClose?.id : undefined} highlightedId={highlightedPreviewId} onClose={setPreviewToClose} />
          )}
        </CardContent>
      </Card>

      <AlertDialog open={previewToClose !== undefined} onOpenChange={(open) => !open && !closePreview.isPending && setPreviewToClose(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><Trash2 aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>{t('Close preview #{number}?', 'Preview #{number} schließen?', { number: previewToClose?.pullRequestNumber ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('Shelter removes its route, container, and preview deployment. The pull request and production deployment are not changed.', 'Shelter entfernt Route, Container und Preview-Deployment. Pull Request und Produktions-Deployment bleiben unverändert.')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closePreview.isPending}>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!previewToClose || closePreview.isPending} onClick={() => previewToClose && closePreview.mutate(previewToClose)}>{closePreview.isPending ? t('Starting cleanup …', 'Cleanup wird gestartet …') : t('Close preview', 'Preview schließen')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={environmentRemovalIndex !== undefined} onOpenChange={(open) => !open && setEnvironmentRemovalIndex(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia><KeyRound aria-hidden="true" /></AlertDialogMedia>
            <AlertDialogTitle>{t('Remove preview variable?', 'Preview-Variable entfernen?')}</AlertDialogTitle>
            <AlertDialogDescription><strong className="text-foreground">{environmentRemovalIndex !== undefined ? environment[environmentRemovalIndex]?.key : ''}</strong>{' '}{t('will be removed permanently when you save the preview environment.', 'wird beim Speichern dauerhaft aus der Preview-Umgebung entfernt.')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Keep variable', 'Variable behalten')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              if (environmentRemovalIndex === undefined) return;
              setEnvironment((current) => current.filter((_, index) => index !== environmentRemovalIndex));
              setEnvironmentRemovalIndex(undefined);
            }}>{t('Mark for removal', 'Zum Entfernen markieren')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
