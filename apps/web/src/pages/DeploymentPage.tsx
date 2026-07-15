import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CircleStop,
  Clock3,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  LoaderCircle,
  RotateCcw,
  Server,
  ShieldCheck,
  TimerOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, api } from '../api/client';
import { DeploymentLogsPanel } from '../components/DeploymentLogsPanel';
import { Button, ErrorState, PageIntro, Skeleton, StatusBadge } from '../components/ui';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  activeDeploymentStates,
  canRequestDeploymentCancellation,
  canRollbackToDeployment,
  cancellableDeploymentStates,
  deploymentAutomaticRecovery,
  deploymentFailureKind,
  deploymentRefetchInterval,
  deploymentSourceLabel,
} from '../utils/deployment';
import { formatDate, formatDuration, formatRelative } from '../utils/format';
import { BRAND_NAME } from '../lib/brand';
import { useI18n, type Translate } from '@/i18n';

function failureTitle(kind: string | null, t: Translate): string {
  if (kind === 'timeout') return t('Deployment timed out', 'Zeitlimit des Deployments überschritten');
  if (kind === 'healthcheck') return t('Health check failed', 'Healthcheck fehlgeschlagen');
  if (kind === 'activation') return t('Activation failed', 'Aktivierung fehlgeschlagen');
  if (kind === 'worker') return t('Deployment worker stopped', 'Deployment-Worker wurde gestoppt');
  return t('Deployment failed', 'Deployment fehlgeschlagen');
}

function failureDescription(kind: string | null, hasActiveProduction: boolean, t: Translate): string {
  if (kind === 'timeout') {
    return hasActiveProduction
      ? t(
          'The build exceeded its configured time limit and was stopped. The active production version was not replaced.',
          'Der Build hat sein konfiguriertes Zeitlimit überschritten und wurde gestoppt. Die aktive Produktionsversion wurde nicht ersetzt.',
        )
      : t(
          'The build exceeded its configured time limit and was stopped. No version was activated, so this project still has no production deployment.',
          'Der Build hat sein konfiguriertes Zeitlimit überschritten und wurde gestoppt. Es wurde keine Version aktiviert; dieses Projekt hat weiterhin kein Produktions-Deployment.',
        );
  }
  if (kind === 'healthcheck') {
    return t(
      'The candidate did not pass its health check and was not activated.',
      'Die neue Version hat den Healthcheck nicht bestanden und wurde nicht aktiviert.',
    );
  }
  if (kind === 'activation') {
    return hasActiveProduction
      ? t(
          'Shelter could not switch production traffic to this version safely. The active version stayed unchanged.',
          'Shelter konnte den Produktions-Traffic nicht sicher auf diese Version umschalten. Die aktive Version blieb unverändert.',
        )
      : t(
          'Shelter could not activate this first version safely. The project still has no production deployment.',
          'Shelter konnte diese erste Version nicht sicher aktivieren. Das Projekt hat weiterhin kein Produktions-Deployment.',
        );
  }
  if (kind === 'worker') {
    return t(
      'The deployment worker could not finish this operation. Review the output before trying again.',
      'Der Deployment-Worker konnte diesen Vorgang nicht abschließen. Prüfe vor einem neuen Versuch die Ausgabe.',
    );
  }
  return hasActiveProduction
    ? t(
        'The build output contains more details about the cause. The active production version was not replaced.',
        'Die Build-Ausgabe enthält weitere Details zur Ursache. Die aktive Produktionsversion wurde nicht ersetzt.',
      )
    : t(
        'The build output contains more details about the cause. No version was activated, so this project still has no production deployment.',
        'Die Build-Ausgabe enthält weitere Details zur Ursache. Es wurde keine Version aktiviert; dieses Projekt hat weiterhin kein Produktions-Deployment.',
      );
}

export type PageErrorContext = 'project' | 'deployment' | 'cancel' | 'rollback';
export type CancelDialogBlock = 'requested' | 'switching' | 'finished';
export type RollbackDialogBlock = 'deletion' | 'deployment-active' | 'target-active' | 'target-unavailable' | 'cancellation';

function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') return null;
  const details = error.details as Record<string, unknown>;
  if (typeof details.code === 'string') return details.code;
  if (details.error && typeof details.error === 'object') {
    const nestedCode = (details.error as Record<string, unknown>).code;
    if (typeof nestedCode === 'string') return nestedCode;
  }
  return null;
}

export function localizedPageError(error: unknown, context: PageErrorContext, t: Translate): string {
  const code = apiErrorCode(error);
  if (code === 'DEPLOYMENT_ACTIVATING') {
    return t('Final activation has already started, so cancellation is no longer safe.', 'Die finale Aktivierung hat bereits begonnen; ein Abbruch ist nicht mehr sicher.');
  }
  if (code === 'DEPLOYMENT_TERMINAL') {
    return t('This deployment has already finished and can no longer be cancelled.', 'Dieses Deployment ist bereits abgeschlossen und kann nicht mehr abgebrochen werden.');
  }
  if (code === 'DEPLOYMENT_ACTIVE') {
    return t('This version is already serving production traffic.', 'Diese Version beantwortet bereits den Produktions-Traffic.');
  }
  if (code === 'PROJECT_UNAVAILABLE') {
    return t('This project is unavailable while deletion or cleanup is in progress.', 'Dieses Projekt ist während der Löschung oder des Cleanups nicht verfügbar.');
  }
  if (code === 'INVALID_ROLLBACK') {
    return t('This version is no longer a valid rollback target.', 'Diese Version ist kein gültiges Rollback-Ziel mehr.');
  }
  if (code === 'NOT_FOUND' || (error instanceof ApiError && error.status === 404)) {
    return context === 'project'
      ? t('This project no longer exists or is unavailable.', 'Dieses Projekt existiert nicht mehr oder ist nicht verfügbar.')
      : t('This deployment no longer exists or is unavailable.', 'Dieses Deployment existiert nicht mehr oder ist nicht verfügbar.');
  }

  if (context === 'project') return t('The project could not be loaded. Please try again.', 'Das Projekt konnte nicht geladen werden. Bitte versuche es erneut.');
  if (context === 'deployment') return t('The deployment could not be loaded. Please try again.', 'Das Deployment konnte nicht geladen werden. Bitte versuche es erneut.');
  if (context === 'cancel') return t('The cancellation request could not be sent. Refresh the status and try again.', 'Die Abbruchanfrage konnte nicht gesendet werden. Aktualisiere den Status und versuche es erneut.');
  return t('The rollback could not be started. Refresh the status and try again.', 'Der Rollback konnte nicht gestartet werden. Aktualisiere den Status und versuche es erneut.');
}

export function cancelDialogBlock(deployment?: { id: string; status: string; cancelRequestedAt?: string | null }): CancelDialogBlock | null {
  if (!deployment || canRequestDeploymentCancellation(deployment)) return null;
  if (deployment.cancelRequestedAt) return 'requested';
  if (deployment.status === 'switching') return 'switching';
  return 'finished';
}

export function rollbackDialogBlock(
  deployment: { id: string; status: string } | undefined,
  project: { status: string; activeDeploymentId?: string | null; deletionStatus?: string | null } | undefined,
  projectDeploymentActive: boolean,
  cancellationPending: boolean,
): RollbackDialogBlock | null {
  if (!deployment || !project) return 'target-unavailable';
  if (project.deletionStatus || project.status === 'deletion_failed') return 'deletion';
  if (projectDeploymentActive) return 'deployment-active';
  if (cancellationPending) return 'cancellation';
  if (project.activeDeploymentId === deployment.id) return 'target-active';
  if (deployment.status !== 'ready') return 'target-unavailable';
  return null;
}

export function DeploymentPage() {
  const { t, locale } = useI18n();
  const { id = '', deploymentId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const cancelCloseRef = useRef<HTMLButtonElement>(null);
  const rollbackCloseRef = useRef<HTMLButtonElement>(null);
  const deploymentQuery = useQuery({
    queryKey: ['deployment', deploymentId],
    queryFn: () => api.deployment(deploymentId),
    enabled: Boolean(deploymentId),
    refetchInterval: (query) => deploymentRefetchInterval(query.state.data),
  });
  const projectQuery = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    enabled: Boolean(id),
    refetchInterval: () => deploymentQuery.data && activeDeploymentStates.has(deploymentQuery.data.status) ? 4_000 : 20_000,
  });
  const project = projectQuery.data;
  const deployment = deploymentQuery.data;
  const deploymentBelongsToProject = Boolean(project && deployment?.projectId === project.id);
  const production = Boolean(deployment && project?.activeDeploymentId === deployment.id);
  const hasActiveProduction = Boolean(project?.activeDeploymentId);
  const cancelDeployment = useMutation({
    mutationFn: () => api.cancelDeployment(deploymentId),
    onSuccess: (cancelled) => {
      setCancelOpen(false);
      queryClient.setQueryData(['deployment', deploymentId], cancelled);
      void queryClient.invalidateQueries({ queryKey: ['deployment-logs', deploymentId] });
      void queryClient.invalidateQueries({ queryKey: ['project', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      const finished = cancelled.status === 'cancelled';
      toast.success(
        finished ? t('Deployment cancelled', 'Deployment abgebrochen') : t('Cancellation requested', 'Abbruch angefordert'),
        {
          description: finished
            ? hasActiveProduction
              ? t('The active production version was not changed.', 'Die aktive Produktionsversion wurde nicht verändert.')
              : t('No version went live. This project still has no active production deployment.', 'Es ging keine Version live. Dieses Projekt hat weiterhin kein aktives Produktions-Deployment.')
            : hasActiveProduction
              ? t('Shelter is stopping the active work and cleaning up its candidate. Production remains online.', 'Shelter stoppt die laufende Arbeit und räumt die unfertige Version auf. Die Produktion bleibt online.')
              : t('Shelter is stopping the active work and cleaning up its candidate. No version has gone live.', 'Shelter stoppt die laufende Arbeit und räumt die unfertige Version auf. Es ist noch keine Version live gegangen.'),
        },
      );
    },
  });
  const rollback = useMutation({
    mutationFn: () => api.rollbackProject(id, deploymentId),
    onSuccess: (queued) => {
      setRollbackOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['project', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('Rollback queued', 'Rollback eingereiht'), {
        description: hasActiveProduction
          ? t('The existing version stays online until the new health check passes.', 'Die bisherige Version bleibt bis zum erfolgreichen Healthcheck online.')
          : t('The selected version will go live only after its health check passes.', 'Die ausgewählte Version geht erst nach einem erfolgreichen Healthcheck live.'),
      });
      navigate(`/projects/${id}/deployments/${queued.id}`);
    },
  });

  const cancellationStateVisible = Boolean(deployment && cancellableDeploymentStates.has(deployment.status));
  const cancellationRequested = Boolean(deployment?.cancelRequestedAt);
  const cancellationAvailable = canRequestDeploymentCancellation(deployment);
  const rollbackAvailable = Boolean(deployment && project && canRollbackToDeployment(deployment, project));
  const projectDeploymentActive = Boolean(
    project && (
      project.status === 'deploying'
      || activeDeploymentStates.has(project.currentDeployment?.status ?? '')
    )
  );
  const rollbackDisabled = projectDeploymentActive || cancelDeployment.isPending;
  const cancelBlock = cancelOpen ? cancelDialogBlock(deployment) : null;
  const rollbackBlock = rollbackOpen
    ? rollbackDialogBlock(deployment, project, projectDeploymentActive, cancelDeployment.isPending)
    : null;

  useEffect(() => {
    document.title = project
      ? deployment
        ? `Deployment ${deployment.id.slice(0, 8)} · ${project.name} · ${BRAND_NAME}`
        : `Deployment · ${project.name} · ${BRAND_NAME}`
      : `Deployment · ${BRAND_NAME}`;
  }, [deployment, project, t]);

  useEffect(() => {
    if (cancelOpen && cancelBlock) cancelCloseRef.current?.focus();
  }, [cancelBlock, cancelOpen]);

  useEffect(() => {
    if (rollbackOpen && rollbackBlock) rollbackCloseRef.current?.focus();
  }, [rollbackBlock, rollbackOpen]);

  if (projectQuery.isLoading || deploymentQuery.isLoading) {
    return (
      <div className="grid gap-6" role="status" aria-label={t('Loading deployment', 'Deployment wird geladen')}>
        <div className="contents" aria-hidden="true">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="grid gap-6">
        <Button asChild variant="ghost" className="w-fit"><Link to="/projects"><ArrowLeft /> {t('All projects', 'Alle Projekte')}</Link></Button>
        <ErrorState
          title={t('Project not found', 'Projekt nicht gefunden')}
          message={localizedPageError(projectQuery.error, 'project', t)}
          action={<Button onClick={() => projectQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  if (deploymentQuery.isError || !deployment || !deploymentBelongsToProject) {
    const deploymentMissing = deploymentQuery.error instanceof ApiError && deploymentQuery.error.status === 404;
    return (
      <div className="grid gap-6">
        <Button asChild variant="ghost" className="-ml-2 w-fit text-muted-foreground">
          <Link to={`/projects/${project.id}?tab=deployments`}><ArrowLeft /> {t('Deployment history', 'Deployment-Verlauf')}</Link>
        </Button>
        <ErrorState
          title={deploymentQuery.isError && !deploymentMissing ? t('Deployment unavailable', 'Deployment nicht erreichbar') : t('Deployment not found', 'Deployment nicht gefunden')}
          message={deploymentQuery.isError && !deploymentMissing
            ? localizedPageError(deploymentQuery.error, 'deployment', t)
            : t('This deployment does not belong to this project or is no longer available.', 'Dieses Deployment gehört nicht zu diesem Projekt oder ist nicht mehr verfügbar.')}
          action={deploymentQuery.isError && !deploymentMissing ? (
            <Button onClick={() => deploymentQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>
          ) : (
            <Button asChild><Link to={`/projects/${project.id}?tab=deployments`}>{t('Open all deployments', 'Alle Deployments öffnen')}</Link></Button>
          )}
        />
      </div>
    );
  }

  const failureKind = deploymentFailureKind(deployment);
  const automaticRecovery = deploymentAutomaticRecovery(deployment);

  return (
    <div className="grid min-w-0 gap-6 sm:gap-7">
      <Button asChild variant="ghost" className="-ml-2 w-fit min-w-0 max-w-[calc(100%+0.5rem)] text-muted-foreground">
        <Link to={`/projects/${project.id}?tab=deployments`}>
          <ArrowLeft />
          <span className="min-w-0 truncate">{project.name}</span>
          <span className="shrink-0">· {t('Deployments', 'Deployments')}</span>
        </Link>
      </Button>

      <PageIntro
        eyebrow={(
          <>
            <StatusBadge status={deployment.status} />
            {production && <Badge variant="secondary">{t('Production', 'Produktion')}</Badge>}
          </>
        )}
        title={`Deployment ${deployment.id.slice(0, 8)}`}
        description={`${deploymentSourceLabel(deployment, project)} · ${formatRelative(deployment.createdAt ?? deployment.startedAt, locale)}`}
        actions={cancellationStateVisible || rollbackAvailable ? (
          <div className="flex flex-wrap justify-end gap-2">
            {cancellationStateVisible && (
              <Button
                variant="danger"
                onClick={() => {
                  cancelDeployment.reset();
                  setCancelOpen(true);
                }}
                loading={cancelDeployment.isPending}
                disabled={!cancellationAvailable || rollback.isPending}
                title={cancellationRequested
                  ? t('Cancellation has already been requested.', 'Der Abbruch wurde bereits angefordert.')
                  : hasActiveProduction
                    ? t('Stops this deployment without changing the active production version.', 'Stoppt dieses Deployment, ohne die aktive Produktionsversion zu verändern.')
                    : t('Stops this deployment before a first production version goes live.', 'Stoppt dieses Deployment, bevor eine erste Produktionsversion live geht.')}
              >
                {!cancelDeployment.isPending && <CircleStop />}
                {cancellationRequested ? t('Cancellation requested', 'Abbruch angefordert') : t('Cancel deployment…', 'Deployment abbrechen …')}
              </Button>
            )}
            {rollbackAvailable && (
              <div className="grid justify-items-end gap-1">
                <Button
                  variant="outline"
                  onClick={() => {
                    rollback.reset();
                    setRollbackOpen(true);
                  }}
                  disabled={rollbackDisabled}
                  title={t('Creates a new deployment from this immutable version.', 'Erstellt aus dieser unveränderlichen Version ein neues Deployment.')}
                >
                  <RotateCcw /> {t('Roll back to this version…', 'Auf diese Version zurückrollen …')}
                </Button>
                {projectDeploymentActive && (
                  <span className="max-w-64 text-right text-xs text-muted-foreground">
                    {t('Available after the current deployment finishes.', 'Verfügbar, sobald das aktuelle Deployment abgeschlossen ist.')}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : undefined}
      />

      {cancellationRequested && activeDeploymentStates.has(deployment.status) && (
        <Alert role="status">
          <LoaderCircle className="animate-spin" />
          <AlertTitle>{t('Cancellation requested', 'Abbruch angefordert')}</AlertTitle>
          <AlertDescription>{hasActiveProduction
            ? t(
                'The worker will stop at the next safe checkpoint. The active production version remains online.',
                'Der Worker stoppt am nächsten sicheren Kontrollpunkt. Die aktive Produktionsversion bleibt online.',
              )
            : t(
                'The worker will stop at the next safe checkpoint. No version is live yet, and this deployment will not be activated.',
                'Der Worker stoppt am nächsten sicheren Kontrollpunkt. Es ist noch keine Version live und dieses Deployment wird nicht aktiviert.',
              )}</AlertDescription>
        </Alert>
      )}

      {deployment.status === 'switching' && (
        <Alert role="status">
          <ShieldCheck />
          <AlertTitle>{t('Final activation in progress', 'Finale Aktivierung läuft')}</AlertTitle>
          <AlertDescription>{hasActiveProduction
            ? t(
                'Shelter is switching traffic atomically from the active version. Cancellation is disabled during this final safety step.',
                'Shelter schaltet den Traffic atomar von der aktiven Version um. Während dieses letzten Sicherheitsschritts ist ein Abbruch deaktiviert.',
              )
            : t(
                'Shelter is safely activating this first version. Cancellation is disabled during this final safety step.',
                'Shelter aktiviert diese erste Version sicher. Während dieses letzten Sicherheitsschritts ist ein Abbruch deaktiviert.',
              )}</AlertDescription>
        </Alert>
      )}

      {deployment.status === 'cancelled' && (
        <Alert className="border-warning/30 bg-warning/5">
          <CircleStop className="text-warning" />
          <AlertTitle>{failureKind === 'superseded'
            ? t('Superseded by a newer deployment', 'Durch ein neueres Deployment ersetzt')
            : t('Deployment cancelled', 'Deployment abgebrochen')}</AlertTitle>
          <AlertDescription>
            <span className="block">{failureKind === 'superseded'
              ? hasActiveProduction
                ? t('Shelter stopped this outdated deployment before it could replace the active production version.', 'Shelter hat dieses veraltete Deployment gestoppt, bevor es die aktive Produktionsversion ersetzen konnte.')
                : t('Shelter stopped this outdated deployment before it could become the first production version.', 'Shelter hat dieses veraltete Deployment gestoppt, bevor es zur ersten Produktionsversion werden konnte.')
              : hasActiveProduction
                ? t('No new version was activated. The active production version stayed unchanged.', 'Es wurde keine neue Version aktiviert. Die aktive Produktionsversion blieb unverändert.')
                : t('No version was activated. This project still has no production deployment.', 'Es wurde keine Version aktiviert. Dieses Projekt hat weiterhin kein Produktions-Deployment.')}</span>
          </AlertDescription>
        </Alert>
      )}

      {deployment.status === 'failed' && (
        <Alert variant="destructive">
          {failureKind === 'timeout' ? <TimerOff /> : <AlertTriangle />}
          <AlertTitle>{failureTitle(failureKind, t)}</AlertTitle>
          <AlertDescription>
            <span className="block">{failureDescription(failureKind, hasActiveProduction, t)}</span>
          </AlertDescription>
        </Alert>
      )}

      {automaticRecovery.status === 'succeeded' && (
        <Alert className="border-success/30 bg-success/5">
          <ShieldCheck className="text-success" />
          <AlertTitle>{t('Production recovered automatically', 'Produktion automatisch wiederhergestellt')}</AlertTitle>
          <AlertDescription>{t(
            'Shelter kept the previous healthy version online. No manual rollback is required.',
            'Shelter hat die vorherige fehlerfreie Version online gehalten. Ein manueller Rollback ist nicht erforderlich.',
          )}</AlertDescription>
          {automaticRecovery.deploymentId && (
            <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit">
              <Link to={`/projects/${project.id}/deployments/${automaticRecovery.deploymentId}`}>{t('Open recovered version', 'Wiederhergestellte Version öffnen')}</Link>
            </Button>
          )}
        </Alert>
      )}

      {automaticRecovery.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t('Automatic recovery failed', 'Automatische Wiederherstellung fehlgeschlagen')}</AlertTitle>
          <AlertDescription>{t(
            'Shelter could not confirm a healthy production version. Review the project immediately and roll back manually if a ready version is available.',
            'Shelter konnte keine fehlerfreie Produktionsversion bestätigen. Prüfe das Projekt sofort und rolle manuell zurück, falls eine bereite Version verfügbar ist.',
          )}</AlertDescription>
          <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit">
            <Link to={`/projects/${project.id}?tab=deployments`}>{t('Review versions', 'Versionen prüfen')}</Link>
          </Button>
        </Alert>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t('Deployment details', 'Deployment-Details')}</CardTitle>
          <CardDescription>{production ? t('This version currently serves production traffic.', 'Diese Version beantwortet aktuell den Produktions-Traffic.') : t('Immutable information about this build.', 'Unveränderliche Informationen zu diesem Build.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-muted-foreground"><GitBranch className="size-3.5" /> {t('Source', 'Quelle')}</dt>
              <dd className="mt-1.5 truncate text-sm font-medium">{deploymentSourceLabel(deployment, project)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Hash className="size-3.5" /> {t('Reference', 'Referenz')}</dt>
              <dd className="mt-1.5 truncate font-mono text-sm font-medium">{deployment.commitSha?.slice(0, 12) ?? deployment.id.slice(0, 12)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-3.5" /> {t('Started', 'Gestartet')}</dt>
              <dd className="mt-1.5 text-sm font-medium">{formatDate(deployment.startedAt ?? deployment.createdAt, locale)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="size-3.5" /> {t('Duration', 'Dauer')}</dt>
              <dd className="mt-1.5 text-sm font-medium">{formatDuration(deployment.durationSeconds)}</dd>
            </div>
            {(deployment.runtimeDescription || deployment.runtimeKind) && (
              <div className="min-w-0 sm:col-span-2">
                <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Server className="size-3.5" /> {t('Runtime', 'Laufzeit')}</dt>
                <dd className="mt-1.5 truncate text-sm font-medium">{deployment.runtimeDescription ?? deployment.runtimeKind}</dd>
              </div>
            )}
            {deployment.internalPort && (
              <div className="min-w-0">
                <dt className="flex items-center gap-2 text-xs text-muted-foreground"><Server className="size-3.5" /> {t('Internal port', 'Interner Port')}</dt>
                <dd className="mt-1.5 font-mono text-sm font-medium">{deployment.internalPort}</dd>
              </div>
            )}
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1.5"><StatusBadge status={deployment.status} /></dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t('Trigger', 'Auslöser')}</dt>
              <dd className="mt-1.5 text-sm font-medium">
                {deployment.trigger === 'github_push' ? 'GitHub Push' : deployment.trigger === 'rollback' ? 'Rollback' : t('Manual', 'Manuell')}
              </dd>
            </div>
          </dl>
          {(deployment.commitMessage || deployment.commitAuthor) && (
            <div className="mt-6 flex min-w-0 items-start gap-3 border-t pt-5">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border bg-muted/30 text-muted-foreground">
                <GitCommitHorizontal className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <span className="text-xs text-muted-foreground">Commit</span>
                {deployment.commitMessage && <p className="mt-1 text-sm font-medium leading-6">{deployment.commitMessage}</p>}
                {deployment.commitAuthor && <p className="mt-1 text-xs text-muted-foreground">{t('by {author}', 'von {author}', { author: deployment.commitAuthor })}</p>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid min-w-0 gap-3" aria-labelledby="deployment-logs-title">
        <div>
          <h2 id="deployment-logs-title" className="text-xl font-semibold tracking-tight">{t('Build output', 'Build-Ausgabe')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{activeDeploymentStates.has(deployment.status) ? t('The output updates live.', 'Die Ausgabe wird live aktualisiert.') : t('Complete log for this deployment.', 'Vollständiges Log dieses Deployments.')}</p>
        </div>
        <DeploymentLogsPanel deployment={deployment} />
      </section>

      <AlertDialog open={cancelOpen} onOpenChange={(open) => {
        if (cancelDeployment.isPending) return;
        setCancelOpen(open);
        if (!open) cancelDeployment.reset();
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive"><CircleStop /></AlertDialogMedia>
            <AlertDialogTitle>{t('Cancel this deployment?', 'Dieses Deployment abbrechen?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelBlock
                ? t('The deployment status changed while this confirmation was open.', 'Der Deployment-Status hat sich geändert, während diese Bestätigung geöffnet war.')
                : deployment.status === 'queued'
                  ? hasActiveProduction
                    ? t('This deployment will be removed from the queue before it can change production. The active production version stays unchanged.', 'Dieses Deployment wird aus der Warteschlange entfernt, bevor es die Produktion verändern kann. Die aktive Produktionsversion bleibt unverändert.')
                    : t('This deployment will be removed from the queue before a first production version can be activated.', 'Dieses Deployment wird aus der Warteschlange entfernt, bevor eine erste Produktionsversion aktiviert werden kann.')
                  : hasActiveProduction
                    ? t('Shelter stops the work at a safe checkpoint and discards the unfinished candidate. The active production version remains online.', 'Shelter stoppt die Arbeit an einem sicheren Kontrollpunkt und verwirft die unfertige Version. Die aktive Produktionsversion bleibt online.')
                    : t('Shelter stops the work at a safe checkpoint and discards the unfinished candidate. No version will be activated.', 'Shelter stoppt die Arbeit an einem sicheren Kontrollpunkt und verwirft die unfertige Version. Es wird keine Version aktiviert.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <span className="block font-medium text-foreground">Deployment {deployment.id.slice(0, 8)}</span>
            <span className="mt-1 block">{deploymentSourceLabel(deployment, project)}</span>
          </div>
          {cancelBlock && (
            <Alert id="cancel-deployment-status-change" role="status" aria-live="polite" className="border-warning/30 bg-warning/5">
              <AlertTriangle className="text-warning" />
              <AlertTitle>{cancelBlock === 'requested'
                ? t('Cancellation already requested', 'Abbruch bereits angefordert')
                : cancelBlock === 'switching'
                  ? t('Cancellation is no longer available', 'Abbruch nicht mehr verfügbar')
                  : t('Deployment already finished', 'Deployment bereits abgeschlossen')}</AlertTitle>
              <AlertDescription>{cancelBlock === 'requested'
                ? t('Shelter has already received the request. Wait for cleanup to finish; you do not need to send it again.', 'Shelter hat die Anfrage bereits erhalten. Warte, bis das Cleanup abgeschlossen ist; du musst sie nicht erneut senden.')
                : cancelBlock === 'switching'
                  ? t('Final activation has started. Cancelling now could interrupt the safe traffic switch.', 'Die finale Aktivierung hat begonnen. Ein Abbruch könnte jetzt die sichere Traffic-Umschaltung unterbrechen.')
                  : t('This deployment reached a final state and can no longer be cancelled. Close this dialog to review the latest status.', 'Dieses Deployment hat einen finalen Status erreicht und kann nicht mehr abgebrochen werden. Schließe diesen Dialog, um den aktuellen Status zu prüfen.')}</AlertDescription>
            </Alert>
          )}
          {cancelDeployment.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t('Deployment could not be cancelled', 'Deployment konnte nicht abgebrochen werden')}</AlertTitle>
              <AlertDescription>{localizedPageError(cancelDeployment.error, 'cancel', t)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelCloseRef} disabled={cancelDeployment.isPending}>
              {cancelBlock ? t('Close', 'Schließen') : t('Keep running', 'Weiterlaufen lassen')}
            </AlertDialogCancel>
            <Button
              variant="danger"
              loading={cancelDeployment.isPending}
              disabled={cancelDeployment.isPending || !cancellationAvailable}
              aria-describedby={cancelBlock ? 'cancel-deployment-status-change' : undefined}
              onClick={() => cancelDeployment.mutate()}
            >
              {!cancelDeployment.isPending && <CircleStop />} {t('Cancel deployment', 'Deployment abbrechen')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rollbackOpen} onOpenChange={(open) => {
        if (rollback.isPending) return;
        setRollbackOpen(open);
        if (!open) rollback.reset();
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-warning/15 text-warning"><RotateCcw /></AlertDialogMedia>
            <AlertDialogTitle>{t('Roll back to this version?', 'Auf diese Version zurückrollen?')}</AlertDialogTitle>
            <AlertDialogDescription>{rollbackBlock
              ? t('The project status changed while this confirmation was open.', 'Der Projektstatus hat sich geändert, während diese Bestätigung geöffnet war.')
              : hasActiveProduction
                ? t(
                    'Shelter creates a new deployment from this immutable version. Current production stays online until the rollback passes its health check.',
                    'Shelter erstellt aus dieser unveränderlichen Version ein neues Deployment. Die aktuelle Produktion bleibt online, bis der Rollback seinen Healthcheck bestanden hat.',
                  )
                : t(
                    'Shelter creates a new deployment from this immutable version. It becomes the first production version only after its health check passes.',
                    'Shelter erstellt aus dieser unveränderlichen Version ein neues Deployment. Es wird erst nach einem erfolgreichen Healthcheck zur ersten Produktionsversion.',
                  )}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <span className="block font-medium text-foreground">Deployment {deployment.id.slice(0, 8)}</span>
            <span className="mt-1 block">{deploymentSourceLabel(deployment, project)}</span>
            <span className="mt-1 block">{formatDate(deployment.finishedAt ?? deployment.startedAt ?? deployment.createdAt, locale)}</span>
          </div>
          {rollbackBlock && (
            <Alert id="rollback-deployment-status-change" role="status" aria-live="polite" className="border-warning/30 bg-warning/5">
              <AlertTriangle className="text-warning" />
              <AlertTitle>{t('Rollback is no longer available', 'Rollback nicht mehr verfügbar')}</AlertTitle>
              <AlertDescription>{rollbackBlock === 'deletion'
                ? t('Project deletion or cleanup is in progress. Rollback stays unavailable until the project is available again.', 'Die Projektlöschung oder das Cleanup läuft. Der Rollback bleibt nicht verfügbar, bis das Projekt wieder verfügbar ist.')
                : rollbackBlock === 'deployment-active'
                  ? t('Another deployment started. Wait for it to finish before starting a rollback.', 'Ein anderes Deployment wurde gestartet. Warte auf dessen Abschluss, bevor du einen Rollback startest.')
                  : rollbackBlock === 'target-active'
                    ? t('This version is now the active production version, so a rollback to it is no longer necessary.', 'Diese Version ist jetzt die aktive Produktionsversion; ein Rollback auf sie ist nicht mehr nötig.')
                    : rollbackBlock === 'cancellation'
                      ? t('Wait until the current cancellation request has finished before starting a rollback.', 'Warte, bis die aktuelle Abbruchanfrage abgeschlossen ist, bevor du einen Rollback startest.')
                      : t('This version is no longer a ready rollback target. Refresh the deployment history and choose another version.', 'Diese Version ist kein bereites Rollback-Ziel mehr. Aktualisiere den Deployment-Verlauf und wähle eine andere Version.')}</AlertDescription>
            </Alert>
          )}
          {rollback.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t('Rollback could not be started', 'Rollback konnte nicht gestartet werden')}</AlertTitle>
              <AlertDescription>{localizedPageError(rollback.error, 'rollback', t)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={rollbackCloseRef} disabled={rollback.isPending}>
              {rollbackBlock
                ? t('Close', 'Schließen')
                : hasActiveProduction
                  ? t('Keep current production', 'Aktuelle Produktion behalten')
                  : t('Do not start rollback', 'Rollback nicht starten')}
            </AlertDialogCancel>
            <Button
              loading={rollback.isPending}
              disabled={rollback.isPending || rollbackDisabled || !rollbackAvailable}
              aria-describedby={rollbackBlock ? 'rollback-deployment-status-change' : undefined}
              onClick={() => rollback.mutate()}
            >
              {!rollback.isPending && <RotateCcw />} {t('Start rollback', 'Rollback starten')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
