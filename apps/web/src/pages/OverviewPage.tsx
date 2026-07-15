import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Cloud,
  FolderKanban,
  GitBranch,
  Globe2,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Button, ErrorState, PageIntro, Skeleton, StatusBadge } from '../components/ui';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import type { Deployment, Project } from '../types';
import { formatDuration, formatRelative } from '../utils/format';
import { deploymentSourceLabel } from '../utils/deployment';
import { isFileStorageProject } from '../utils/project-runtime';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { ProductionSafetyAlert } from '../components/ProductionSafetyAlert';

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  to,
  alert = false,
}: {
  icon: typeof FolderKanban;
  label: string;
  value: number;
  detail: string;
  to: string;
  alert?: boolean;
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={`${label}: ${value}. ${detail}`}
    >
      <Card className="h-full gap-3 py-4 shadow-sm transition-colors group-hover:border-foreground/20 group-hover:bg-muted/20 sm:py-5">
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-3">
          <div>
            <CardDescription className="font-medium">{label}</CardDescription>
            <CardTitle className={cn('mt-2 text-3xl tabular-nums', alert && 'text-destructive')}>{value}</CardTitle>
          </div>
          <span className={cn(
            'grid size-9 place-items-center rounded-lg border bg-muted/40 text-muted-foreground',
            alert && 'border-destructive/20 bg-destructive/5 text-destructive',
          )}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{detail}</span>
          <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </CardContent>
      </Card>
    </Link>
  );
}

function ProjectActivityRow({ project }: { project: Project }) {
  const { t, locale } = useI18n();
  const domain = project.domains?.[0];
  const deployment = project.currentDeployment ?? project.deployments?.[0];
  const sourceLabel = project.repositoryUrl
    ? project.repositoryUrl.replace(/^https?:\/\//, '')
    : project.sourceType === 'upload'
      ? isFileStorageProject(project) ? t('File storage', 'Dateiablage') : t('Direct upload', 'Direkt-Upload')
      : t('Project source', 'Projektquelle');

  return (
    <li>
      <Link
        to={`/projects/${project.id}`}
        className="group grid gap-3 px-4 py-4 outline-none transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:grid-cols-[minmax(0,1.4fr)_minmax(10rem,0.85fr)_auto] sm:items-center sm:px-6"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30 text-muted-foreground">
            {project.sourceType === 'git'
              ? <GitBranch className="size-4" aria-hidden="true" />
              : <Upload className="size-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <strong className="truncate text-sm font-medium group-hover:underline group-hover:underline-offset-4">{project.name}</strong>
              <StatusBadge status={project.status} />
            </div>
            <span className="mt-1 block truncate text-xs text-muted-foreground" title={sourceLabel}>{sourceLabel}</span>
          </div>
        </div>

        <div className="min-w-0 text-xs">
          <span className="block text-muted-foreground">{domain ? t('Primary domain', 'Primäre Domain') : 'Routing'}</span>
          <span className="mt-1 block truncate font-medium text-foreground">
            {domain?.hostname ?? t('No domain yet', 'Noch keine Domain')}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <span className="text-xs text-muted-foreground">
            {formatRelative(deployment?.finishedAt ?? deployment?.createdAt ?? project.updatedAt, locale)}
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </div>
      </Link>
    </li>
  );
}

function DeploymentRow({ deployment, projects }: { deployment: Deployment; projects: Project[] }) {
  const { t, locale } = useI18n();
  const project = projects.find((candidate) => candidate.id === deployment.projectId);
  const projectName = deployment.projectName ?? project?.name ?? t('Unknown project', 'Unbekanntes Projekt');
  const row = (
    <>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-medium">{projectName}</strong>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {deployment.commitMessage ?? (project ? deploymentSourceLabel(deployment, project) : deployment.sourceRef ?? 'Deployment')}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[0.65rem] text-muted-foreground/80">
          {deployment.commitSha?.slice(0, 10) ?? deployment.sourceRef ?? deployment.id.slice(0, 10)}{deployment.commitAuthor ? ` · ${deployment.commitAuthor}` : ''}
        </span>
      </div>
      <StatusBadge status={deployment.status} />
      <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(deployment.durationSeconds)}</span>
      <span className="text-xs text-muted-foreground">{formatRelative(deployment.finishedAt ?? deployment.startedAt ?? deployment.createdAt, locale)}</span>
      {deployment.projectId && <ArrowUpRight className="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />}
    </>
  );

  return (
    <li>
      {deployment.projectId ? (
        <Link
          to={`/projects/${deployment.projectId}/deployments/${deployment.id}`}
          className="grid gap-3 px-4 py-4 outline-none transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 sm:grid-cols-[minmax(0,1fr)_auto_4rem_7rem_auto] sm:items-center sm:px-6"
        >
          {row}
        </Link>
      ) : (
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_4rem_7rem] sm:items-center sm:px-6">{row}</div>
      )}
    </li>
  );
}

function DashboardSkeleton() {
  const { t } = useI18n();
  return (
    <div className="grid gap-8" role="status" aria-label={t('Loading dashboard', 'Dashboard wird geladen')}>
      <div className="space-y-3 border-b pb-6"><Skeleton className="h-10 w-64" /><Skeleton className="h-5 w-full max-w-xl" /></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <Skeleton className="h-36" key={item} />)}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,0.75fr)]">
        <Skeleton className="h-[27rem]" />
        <Skeleton className="h-[27rem]" />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

export function OverviewPage() {
  const { t } = useI18n();
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });

  const data = overview.data;
  const projects = data?.projects ?? [];
  const recentProjects = useMemo(() => [...projects]
    .sort((left, right) => new Date(right.updatedAt ?? right.createdAt ?? 0).getTime()
      - new Date(left.updatedAt ?? left.createdAt ?? 0).getTime())
    .slice(0, 5), [projects]);
  const deployments = data?.recentDeployments ?? [];
  const stats = data?.stats;
  const projectCount = stats?.projects ?? projects.length;
  const liveCount = stats?.running ?? projects.filter((project) => Boolean(project.activeDeploymentId)).length;
  const domainCount = stats?.domains ?? projects.reduce((sum, project) => sum + (project.domains?.length ?? 0), 0);
  const deployingCount = stats?.deploying ?? projects.filter((project) => project.status === 'deploying').length;
  const failedCount = stats?.failed ?? stats?.failedDeployments
    ?? projects.filter((project) => project.status === 'failed' || project.status === 'deletion_failed').length;
  const workerOnline = data?.system?.workerOnline;
  const tunnelConfigured = Boolean(data?.system?.tunnelConfigured || data?.cloudflare?.configured || data?.cloudflare?.connected);
  const accessProtection = data?.system?.accessProtection;
  const systemReady = workerOnline !== false && tunnelConfigured;

  if (overview.isLoading && !data) return <DashboardSkeleton />;

  if (overview.isError && !data) {
    return (
      <div className="grid gap-8">
        <PageIntro title="Dashboard" description={t('The current state of your projects, deployments, and infrastructure.', 'Der aktuelle Zustand deiner Projekte, Deployments und Infrastruktur.')} />
        <ErrorState
          title={t('Dashboard unavailable', 'Dashboard nicht erreichbar')}
          message={overview.error instanceof Error ? overview.error.message : t('The overview could not be loaded.', 'Die Übersicht konnte nicht geladen werden.')}
          action={<Button onClick={() => void overview.refetch()}><RefreshCw aria-hidden="true" /> {t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  const attention = workerOnline === false
    ? {
        title: t('Deployment worker offline', 'Deployment-Worker offline'),
        description: t('New builds are not being processed. Published projects remain available.', 'Neue Builds werden momentan nicht verarbeitet. Bereits veröffentlichte Projekte bleiben erreichbar.'),
        to: '/settings/cloudflare',
        action: t('Check system', 'System prüfen'),
        destructive: true,
      }
    : failedCount > 0
      ? {
          title: failedCount === 1
            ? t('1 project needs attention', '1 Projekt braucht Aufmerksamkeit')
            : t('{count} projects need attention', '{count} Projekte brauchen Aufmerksamkeit', { count: failedCount }),
          description: t('At least one recent build or deletion failed.', 'Mindestens ein letzter Build oder Löschvorgang ist fehlgeschlagen.'),
          to: '/projects',
          action: t('Check projects', 'Projekte prüfen'),
          destructive: true,
        }
      : !tunnelConfigured
        ? {
            title: t('Set up Cloudflare routing', 'Cloudflare Routing einrichten'),
            description: t('Connect a Zero Trust tunnel so projects can be reached on their own domains.', 'Verbinde einen Zero-Trust-Tunnel, damit Projekte über eigene Domains erreichbar werden.'),
            to: '/settings/cloudflare',
            action: t('Open Cloudflare', 'Cloudflare öffnen'),
            destructive: false,
          }
        : null;

  return (
    <div className="flex w-full flex-col gap-8">
      <PageIntro
        eyebrow={<><Activity className="size-4" aria-hidden="true" /> {t('Overview', 'Übersicht')}</>}
        title="Dashboard"
        description={t('What is running, what happened recently, and where action is needed.', 'Was gerade läuft, was zuletzt passiert ist und wo du handeln solltest.')}
        actions={<Button asChild size="lg"><Link to="/projects/new"><Plus aria-hidden="true" /> {t('New project', 'Neues Projekt')}</Link></Button>}
      />

      {overview.isError && data && (
        <Alert className="border-warning/40 bg-warning/10 text-warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t('The overview may be out of date', 'Die Übersicht ist möglicherweise nicht aktuell')}</AlertTitle>
          <AlertDescription className="text-warning/80">{t('Shelter is showing the last available data.', 'Shelter zeigt die zuletzt verfügbaren Daten.')}</AlertDescription>
          <div className="col-span-full mt-2 sm:col-start-2">
            <Button variant="outline" size="sm" onClick={() => void overview.refetch()}><RefreshCw aria-hidden="true" /> {t('Reload', 'Neu laden')}</Button>
          </div>
        </Alert>
      )}

      <ProductionSafetyAlert accessProtection={accessProtection} />

      {attention && (
        <Alert variant={attention.destructive ? 'destructive' : 'default'} className="items-start p-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{attention.title}</AlertTitle>
          <AlertDescription>{attention.description}</AlertDescription>
          <div className="col-span-full mt-2 sm:col-start-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={attention.to}>{attention.action} <ArrowRight aria-hidden="true" /></Link>
            </Button>
          </div>
        </Alert>
      )}

      <section aria-label={t('Metrics', 'Kennzahlen')} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={FolderKanban} label={t('Projects', 'Projekte')} value={projectCount} detail={t('Open all projects', 'Alle Projekte öffnen')} to="/projects" />
        <MetricCard icon={Rocket} label={t('In production', 'In Produktion')} value={liveCount} detail={t('{count} not live', '{count} nicht live', { count: Math.max(0, projectCount - liveCount) })} to="/projects" />
        <MetricCard icon={Globe2} label="Domains" value={domainCount} detail="Cloudflare routing" to="/settings/cloudflare" />
        <MetricCard
          icon={Activity}
          label={t('Needs attention', 'Handlungsbedarf')}
          value={failedCount}
          detail={deployingCount === 1 ? t('1 active build', '1 Build aktiv') : t('{count} active builds', '{count} Builds aktiv', { count: deployingCount })}
          to="/projects"
          alert={failedCount > 0}
        />
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,0.75fr)]">
        <section className="min-w-0" aria-labelledby="dashboard-projects-title">
          <Card className="h-full gap-0 py-0">
            <CardHeader className="border-b py-5 sm:px-6">
              <CardTitle><h2 id="dashboard-projects-title">{t('Recent projects', 'Aktuelle Projekte')}</h2></CardTitle>
              <CardDescription>{t('Recently changed projects with production status and routing.', 'Zuletzt geänderte Projekte mit Produktionsstatus und Routing.')}</CardDescription>
              <CardAction><Button asChild variant="ghost" size="sm"><Link to="/projects">{t('View all', 'Alle anzeigen')} <ArrowRight aria-hidden="true" /></Link></Button></CardAction>
            </CardHeader>
            <CardContent className="p-0">
              {recentProjects.length > 0 ? (
                <ul className="divide-y">{recentProjects.map((project) => <ProjectActivityRow project={project} key={project.id} />)}</ul>
              ) : (
                <Empty className="min-h-72 rounded-none p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><FolderKanban aria-hidden="true" /></EmptyMedia>
                    <EmptyTitle>{t('No projects yet', 'Noch keine Projekte')}</EmptyTitle>
                    <EmptyDescription>{t('Create your first project from Git, a ZIP archive, or a folder.', 'Dein erstes Projekt kann aus Git oder einem ZIP beziehungsweise Ordner entstehen.')}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button asChild><Link to="/projects/new">{t('Create project', 'Projekt anlegen')} <ArrowRight aria-hidden="true" /></Link></Button></EmptyContent>
                </Empty>
              )}
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="system-status-title">
          <Card className="h-full gap-0 py-0">
            <CardHeader className="border-b py-5">
              <CardTitle><h2 id="system-status-title">{t('System status', 'Systemstatus')}</h2></CardTitle>
              <CardDescription>{t('Deployment node and public tunnel.', 'Deployment-Node und öffentlicher Tunnel.')}</CardDescription>
              <CardAction>
                <Badge variant={workerOnline === false ? 'destructive' : 'outline'}>
                  {workerOnline === false ? t('Action required', 'Handlung nötig') : systemReady ? t('Operational', 'Betriebsbereit') : t('Setup required', 'Einrichtung offen')}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-0 px-0">
              <div className="flex items-center gap-3 border-b px-4 py-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30 text-muted-foreground"><Server className="size-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">{t('Deployment worker', 'Deployment-Worker')}</strong>
                  <span className="block text-xs text-muted-foreground">{t('Builds and health checks', 'Builds und Healthchecks')}</span>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
                  <span className={cn('size-1.5 rounded-full', workerOnline === false ? 'bg-destructive' : 'bg-success')} aria-hidden="true" />
                  {workerOnline === false ? 'Offline' : 'Online'}
                </span>
              </div>

              <div className="flex items-center gap-3 border-b px-4 py-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30 text-muted-foreground"><Cloud className="size-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">Cloudflare Tunnel</strong>
                  <span className="block text-xs text-muted-foreground">{t('Zero Trust routing', 'Zero-Trust-Routing')}</span>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
                  <span className={cn('size-1.5 rounded-full', tunnelConfigured ? 'bg-success' : 'bg-warning')} aria-hidden="true" />
                  {tunnelConfigured ? t('Configured', 'Eingerichtet') : t('Pending', 'Offen')}
                </span>
              </div>

              <div className="flex items-center gap-3 border-b px-4 py-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30 text-muted-foreground"><ShieldCheck className="size-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">Cloudflare Access</strong>
                  <span className="block text-xs text-muted-foreground">{t('Manual security posture for the panel', 'Manueller Sicherheitsstatus des Panels')}</span>
                </div>
                <span className="flex shrink-0 items-center gap-2 text-xs font-medium">
                  <span className={cn(
                    'size-1.5 rounded-full',
                    accessProtection?.status === 'confirmed_by_admin'
                      ? 'bg-success'
                      : accessProtection?.status === 'action_required'
                        ? 'bg-destructive'
                        : 'bg-muted-foreground/50',
                  )} aria-hidden="true" />
                  {accessProtection?.status === 'confirmed_by_admin'
                    ? t('Confirmed', 'Bestätigt')
                    : accessProtection?.status === 'action_required'
                      ? t('Action required', 'Handlung nötig')
                      : t('Not applicable', 'Nicht anwendbar')}
                </span>
              </div>

              <div className="flex items-center gap-3 px-4 py-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30 text-muted-foreground"><Globe2 className="size-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <strong className="block text-sm font-medium">{t('Public domains', 'Öffentliche Domains')}</strong>
                  <span className="block text-xs text-muted-foreground">{t('Published through Traefik', 'Über Traefik veröffentlicht')}</span>
                </div>
                <span className="text-sm font-semibold tabular-nums">{domainCount}</span>
              </div>
            </CardContent>
            <div className="mt-auto grid gap-2 border-t p-4">
              <Button asChild variant="outline" className="w-full"><Link to="/server">{t('View server metrics', 'Servermetriken öffnen')} <ArrowRight aria-hidden="true" /></Link></Button>
              <Button asChild variant="ghost" className="w-full"><Link to="/settings/cloudflare">{t('Manage routing', 'Routing verwalten')} <ArrowRight aria-hidden="true" /></Link></Button>
            </div>
          </Card>
        </section>
      </div>

      <section aria-labelledby="deployment-activity-title">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-5 sm:px-6">
            <CardTitle><h2 id="deployment-activity-title">{t('Recent deployments', 'Letzte Deployments')}</h2></CardTitle>
            <CardDescription>{t('The latest builds across all projects.', 'Die neuesten Builds über alle Projekte hinweg.')}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {deployments.length > 0 ? (
              <ul className="divide-y">{deployments.slice(0, 6).map((deployment) => <DeploymentRow deployment={deployment} projects={projects} key={deployment.id} />)}</ul>
            ) : (
              <Empty className="min-h-44 rounded-none p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Activity aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{t('No deployment activity yet', 'Noch keine Deployment-Aktivität')}</EmptyTitle>
                  <EmptyDescription>{t('A project’s build history appears here after you create it.', 'Sobald du ein Projekt anlegst, erscheint sein Build-Verlauf hier.')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
