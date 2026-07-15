import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Box,
  CloudCog,
  Files,
  GitBranch,
  ImageOff,
  LayoutGrid,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { api } from '../api/client';
import { Button, ErrorState, PageIntro, Skeleton, StatusBadge } from '../components/ui';
import type { Project } from '../types';
import { formatRelative } from '../utils/format';
import { isFileStorageProject, projectRuntimeSearchTerms } from '../utils/project-runtime';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { ProductionSafetyAlert } from '../components/ProductionSafetyAlert';

const INITIAL_PROJECT_COUNT = 8;
const PROJECT_VIEW_STORAGE_KEY = 'shelter-project-view';
type ProjectView = 'list' | 'grid';

function storedProjectView(): ProjectView {
  if (typeof window === 'undefined') return 'list';
  return window.localStorage.getItem(PROJECT_VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
}

function ProjectRow({ project }: { project: Project }) {
  const { t, locale } = useI18n();
  const deployment = project.currentDeployment ?? project.deployments?.[0];
  const fileStorage = isFileStorageProject(project);
  const primaryDomain = project.domains?.[0];
  const sourceLabel = project.repositoryUrl
    ? project.repositoryUrl.replace(/^https?:\/\//, '')
    : fileStorage
      ? t('File storage', 'Dateiablage')
      : project.framework ?? t('Direct upload', 'Direkt-Upload');
  const projectUrl = `/projects/${project.id}`;
  const domainUrl = primaryDomain?.url ?? (primaryDomain?.hostname ? `https://${primaryDomain.hostname}` : undefined);

  return (
    <li className="grid gap-4 px-4 py-4 transition-colors hover:bg-muted/30 sm:px-6 md:grid-cols-[minmax(0,1.35fr)_minmax(10rem,0.9fr)_minmax(12rem,0.9fr)] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link className="truncate font-medium hover:underline hover:underline-offset-4" to={projectUrl}>
            {project.name}
          </Link>
          <StatusBadge status={project.status} />
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {project.sourceType === 'git' ? (
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Upload className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate" title={sourceLabel}>{sourceLabel}</span>
        </div>
      </div>

      <div className="min-w-0 text-sm">
        <span className="block text-xs text-muted-foreground">Domain</span>
        {domainUrl && primaryDomain?.hostname ? (
          <a
            className="mt-1 inline-flex max-w-full items-center gap-1 font-medium hover:underline hover:underline-offset-4"
            href={domainUrl}
            target="_blank"
            rel="noreferrer"
            title={primaryDomain.hostname}
          >
            <span className="truncate">{primaryDomain.hostname}</span>
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
          </a>
        ) : (
          <Link className="mt-1 inline-flex font-medium text-muted-foreground hover:text-foreground hover:underline" to={`${projectUrl}?tab=domains`}>
            {t('Connect domain', 'Domain verbinden')}
          </Link>
        )}
      </div>

      <div className="min-w-0 text-sm">
        <span className="block text-xs text-muted-foreground">{t('Latest deploy', 'Letzter Deploy')}</span>
        {deployment ? (
          <Link className="mt-1 flex min-w-0 flex-wrap items-center gap-2 hover:underline hover:underline-offset-4" to={`${projectUrl}/deployments/${deployment.id}`}>
            <StatusBadge status={deployment.status} />
            <span className="truncate text-xs text-muted-foreground">
              {formatRelative(deployment.finishedAt ?? deployment.createdAt ?? project.updatedAt, locale)}
            </span>
          </Link>
        ) : (
          <span className="mt-1 block text-muted-foreground">{t('No deployment yet', 'Noch kein Deployment')}</span>
        )}
      </div>
    </li>
  );
}

function ProjectRowsSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t('Loading projects', 'Projekte werden geladen')}>
      <div className="divide-y" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="grid gap-4 px-4 py-5 sm:px-6 md:grid-cols-[minmax(0,1.35fr)_minmax(10rem,0.9fr)_minmax(12rem,0.9fr)] md:items-center" key={index}>
            <div className="grid gap-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-56 max-w-full" /></div>
            <div className="grid gap-2"><Skeleton className="h-3 w-14" /><Skeleton className="h-4 w-28" /></div>
            <div className="grid gap-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-4 w-24" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectGridCard({ project }: { project: Project }) {
  const { t, locale } = useI18n();
  const deployment = project.currentDeployment ?? project.deployments?.[0];
  const primaryDomain = project.domains?.[0];
  const projectUrl = `/projects/${project.id}`;
  const domainUrl = primaryDomain?.url ?? (primaryDomain?.hostname ? `https://${primaryDomain.hostname}` : undefined);
  const previewReady = project.preview?.status === 'ready' && Boolean(project.preview.imageUrl);
  const fileStorage = isFileStorageProject(project);
  const sourceLabel = project.repositoryUrl?.replace(/^https?:\/\//, '')
    ?? (fileStorage ? t('File storage', 'Dateiablage') : project.framework)
    ?? t('Direct upload', 'Direkt-Upload');

  return (
    <Card className="group relative min-w-0 gap-0 overflow-hidden py-0 transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md">
      <Link
        to={projectUrl}
        className="relative block aspect-[16/9] overflow-hidden border-b bg-muted/35 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        aria-label={t('Open {name}', '{name} öffnen', { name: project.name })}
      >
        {fileStorage ? (
          <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_top,var(--background),var(--muted))] text-muted-foreground">
            <span className="grid justify-items-center gap-2 text-xs">
              <span className="grid size-11 place-items-center rounded-xl border bg-background shadow-sm">
                <Files className="size-5" aria-hidden="true" />
              </span>
              {t('File storage', 'Dateiablage')}
            </span>
          </div>
        ) : previewReady ? (
          <img
            src={project.preview?.imageUrl}
            alt=""
            className="size-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.015]"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_top,var(--background),var(--muted))] text-muted-foreground">
            <span className="grid justify-items-center gap-2 text-xs">
              {project.preview?.status === 'pending'
                ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
                : <ImageOff className="size-5" aria-hidden="true" />}
              {project.preview?.status === 'pending' ? t('Creating preview', 'Vorschau wird erstellt') : t('No website preview', 'Keine Website-Vorschau')}
            </span>
          </div>
        )}
        <span className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </Link>

      <CardHeader className="gap-2 p-4 pb-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">
              <Link className="outline-none hover:underline hover:underline-offset-4 focus-visible:underline" to={projectUrl}>{project.name}</Link>
            </CardTitle>
            <CardDescription className="mt-1 flex min-w-0 items-center gap-1.5">
              {project.sourceType === 'git' ? <GitBranch className="size-3.5 shrink-0" /> : <Upload className="size-3.5 shrink-0" />}
              <span className="truncate">{sourceLabel}</span>
            </CardDescription>
          </div>
          <StatusBadge status={project.status} className="shrink-0" />
        </div>
      </CardHeader>

      <CardContent className="mt-auto grid gap-3 border-t bg-muted/10 px-4 py-3 text-xs">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-muted-foreground">Domain</span>
          {domainUrl && primaryDomain?.hostname ? (
            <a className="flex min-w-0 items-center gap-1 font-medium hover:underline" href={domainUrl} target="_blank" rel="noreferrer">
              <span className="truncate">{primaryDomain.hostname}</span><ArrowUpRight className="size-3.5 shrink-0" />
            </a>
          ) : (
            <Link className="font-medium text-muted-foreground hover:text-foreground hover:underline" to={`${projectUrl}?tab=domains`}>{t('Connect', 'Verbinden')}</Link>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">{t('Latest deploy', 'Letzter Deploy')}</span>
          <span className="truncate font-medium">{deployment ? formatRelative(deployment.finishedAt ?? deployment.createdAt ?? project.updatedAt, locale) : t('None yet', 'Noch keiner')}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectGridSkeleton() {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-3" role="status" aria-label={t('Loading projects', 'Projekte werden geladen')}>
      {Array.from({ length: 6 }, (_, index) => (
        <div className="overflow-hidden rounded-xl border" key={index}>
          <Skeleton className="aspect-[16/9] rounded-none" />
          <div className="grid gap-2 p-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-full" /></div>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleProjectCount, setVisibleProjectCount] = useState(INITIAL_PROJECT_COUNT);
  const [projectView, setProjectView] = useState<ProjectView>(storedProjectView);
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 30_000 });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 30_000 });

  const data = overview.data;
  const overviewHasProjects = Array.isArray(data?.projects);
  const projects = projectsQuery.data ?? data?.projects ?? [];
  const projectsLoading = projectsQuery.isLoading && !overviewHasProjects;
  const projectsUnavailable = projectsQuery.isError && !overviewHasProjects;
  const fatalError = overview.isError && projectsQuery.isError && !data && !projectsQuery.data;

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase('de');
  const filteredProjects = useMemo(() => {
    if (!normalizedSearch) return projects;
    return projects.filter((project) => {
      const searchable = [
        project.name,
        project.repositoryUrl,
        project.framework,
        project.buildType,
        ...projectRuntimeSearchTerms(project),
        project.currentDeployment?.runtimeKind,
        ...(project.deployments ?? []).map((deployment) => deployment.runtimeKind),
        project.status,
        ...(project.domains ?? []).map((domain) => domain.hostname),
      ].filter(Boolean).join(' ').toLocaleLowerCase('de');
      return searchable.includes(normalizedSearch);
    });
  }, [normalizedSearch, projects]);

  const visibleProjects = filteredProjects.slice(0, visibleProjectCount);
  const remainingProjects = Math.max(0, filteredProjects.length - visibleProjects.length);
  const cloudflareConfigured = Boolean(data?.cloudflare?.configured || data?.system?.tunnelConfigured);
  const cloudflareConnected = data?.cloudflare?.connected ?? data?.system?.tunnelConfigured ?? false;
  const infrastructureIssue = data?.system?.workerOnline === false
    ? {
        title: t('The deployment worker is offline', 'Der Deployment-Worker ist offline'),
        description: t('New builds cannot be processed right now. Existing projects remain available.', 'Neue Builds können momentan nicht verarbeitet werden. Bestehende Projekte bleiben erreichbar.'),
        action: t('Reload status', 'Status neu laden'),
        kind: 'worker' as const,
      }
    : !overview.isLoading && data && !cloudflareConfigured
      ? {
          title: t('Cloudflare routing is not configured', 'Cloudflare Routing ist noch nicht eingerichtet'),
          description: t('Connect Cloudflare so projects become available on their own domains.', 'Verbinde Cloudflare, damit Projekte über eigene Domains erreichbar werden.'),
          action: t('Set up Cloudflare', 'Cloudflare einrichten'),
          kind: 'cloudflare' as const,
        }
      : !overview.isLoading && data && cloudflareConfigured && !cloudflareConnected
        ? {
            title: t('Cloudflare Tunnel is not connected', 'Cloudflare Tunnel ist nicht verbunden'),
            description: t('Check the tunnel connection before publishing new domains.', 'Prüfe die Tunnel-Verbindung, bevor du neue Domains veröffentlichst.'),
            action: t('Check connection', 'Verbindung prüfen'),
            kind: 'cloudflare' as const,
          }
        : null;

  useEffect(() => {
    window.localStorage.setItem(PROJECT_VIEW_STORAGE_KEY, projectView);
  }, [projectView]);

  if (fatalError) {
    return (
      <div className="flex w-full flex-col gap-8">
        <PageIntro
          title={t('Projects', 'Projekte')}
          description={t('Manage websites, deployments, and domains in one place.', 'Verwalte deine Websites, Deployments und Domains an einem Ort.')}
        />
        <ErrorState
          title={t('Project overview unavailable', 'Projektübersicht nicht erreichbar')}
          message={overview.error instanceof Error ? overview.error.message : t('The overview could not be loaded.', 'Die Übersicht konnte nicht geladen werden.')}
          action={(
            <Button onClick={() => { void overview.refetch(); void projectsQuery.refetch(); }}>
              <RefreshCw aria-hidden="true" /> {t('Try again', 'Erneut versuchen')}
            </Button>
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <PageIntro
        title={t('Projects', 'Projekte')}
        description={t('Deploy websites, connect domains, and keep track of deployments.', 'Websites bereitstellen, Domains verbinden und Deployments im Blick behalten.')}
        actions={(
          <Button asChild size="lg">
            <Link to="/projects/new"><Plus aria-hidden="true" /> {t('New project', 'Neues Projekt')}</Link>
          </Button>
        )}
      />

      {(overview.isError || projectsQuery.isError) && (
        <Alert className="border-warning/40 bg-warning/10 text-warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t('Some data is currently out of date', 'Ein Teil der Daten ist momentan nicht aktuell')}</AlertTitle>
          <AlertDescription className="text-warning/80">
            {overview.isError
              ? t('System status and recent activity could not be refreshed. The project list remains available.', 'Systemstatus und letzte Aktivitäten konnten nicht aktualisiert werden. Die Projektliste bleibt verfügbar.')
              : t('The separate project request failed. Shelter shows the last available overview.', 'Die separate Projektabfrage ist fehlgeschlagen. Shelter zeigt die zuletzt verfügbare Übersicht.')}
          </AlertDescription>
          <div className="col-span-full mt-2 sm:col-start-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void overview.refetch(); void projectsQuery.refetch(); }}
            >
              <RefreshCw aria-hidden="true" /> {t('Reload data', 'Daten neu laden')}
            </Button>
          </div>
        </Alert>
      )}

      <ProductionSafetyAlert accessProtection={data?.system?.accessProtection} />

      {infrastructureIssue && (
        <Alert variant={infrastructureIssue.kind === 'worker' ? 'destructive' : 'default'} className="items-start p-4">
          {infrastructureIssue.kind === 'worker'
            ? <TriangleAlert aria-hidden="true" />
            : <CloudCog aria-hidden="true" />}
          <AlertTitle>{infrastructureIssue.title}</AlertTitle>
          <AlertDescription>{infrastructureIssue.description}</AlertDescription>
          <div className="col-span-full mt-2 sm:col-start-2">
            {infrastructureIssue.kind === 'cloudflare' ? (
              <Button variant="outline" size="sm" asChild>
                <Link to="/settings/cloudflare">{infrastructureIssue.action} <ArrowRight aria-hidden="true" /></Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void overview.refetch()}>
                <RefreshCw aria-hidden="true" /> {infrastructureIssue.action}
              </Button>
            )}
          </div>
        </Alert>
      )}

      <section className="min-w-0" aria-labelledby="projects-title">
        <Card className="gap-0 py-0">
          <CardHeader className="gap-4 border-b p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,24rem)_auto] lg:items-end">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-xl font-semibold tracking-tight">
                  <h2 id="projects-title">{t('All projects', 'Alle Projekte')}</h2>
                </CardTitle>
                {!projectsLoading && !projectsUnavailable && <Badge variant="secondary">{filteredProjects.length}</Badge>}
              </div>
              <CardDescription className="mt-1">{t('Projects, domains, and latest deployment.', 'Projekte, Domains und letzter Deploy.')}</CardDescription>
            </div>

            {projects.length > 0 && (
              <div className="relative w-full">
                <label className="sr-only" htmlFor="project-search">{t('Search projects', 'Projekte durchsuchen')}</label>
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="project-search"
                  type="search"
                  className="h-10 pr-10 pl-9"
                  placeholder={t('Name, domain, or repository', 'Name, Domain oder Repository')}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setVisibleProjectCount(INITIAL_PROJECT_COUNT);
                  }}
                />
                {searchQuery && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-2 -translate-y-1/2"
                    onClick={() => {
                      setSearchQuery('');
                      setVisibleProjectCount(INITIAL_PROJECT_COUNT);
                    }}
                    aria-label={t('Clear search', 'Suche leeren')}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
                <p className="sr-only" role="status" aria-live="polite">{t('{count} projects found', '{count} Projekte gefunden', { count: filteredProjects.length })}</p>
              </div>
            )}

            {projects.length > 0 && (
              <div className="flex h-10 items-center rounded-lg border bg-muted/25 p-1" role="group" aria-label={t('Project view', 'Darstellung der Projekte')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn('h-8 w-8', projectView === 'list' && 'bg-background shadow-sm hover:bg-background')}
                  onClick={() => setProjectView('list')}
                  aria-label={t('List view', 'Listenansicht')}
                  aria-pressed={projectView === 'list'}
                  title={t('List view', 'Listenansicht')}
                ><List aria-hidden="true" /></Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn('h-8 w-8', projectView === 'grid' && 'bg-background shadow-sm hover:bg-background')}
                  onClick={() => setProjectView('grid')}
                  aria-label={t('Grid view', 'Kachelansicht')}
                  aria-pressed={projectView === 'grid'}
                  title={t('Grid view', 'Kachelansicht')}
                ><LayoutGrid aria-hidden="true" /></Button>
              </div>
            )}
          </CardHeader>

          <CardContent className="p-0">
            {projectsLoading ? (
              projectView === 'grid' ? <ProjectGridSkeleton /> : <ProjectRowsSkeleton />
            ) : projectsUnavailable ? (
              <div className="p-4 sm:p-6">
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{t('Projects could not be loaded', 'Projekte konnten nicht geladen werden')}</AlertTitle>
                  <AlertDescription>
                    {projectsQuery.error instanceof Error ? projectsQuery.error.message : t('The project list is currently unavailable.', 'Die Projektliste ist momentan nicht verfügbar.')}
                  </AlertDescription>
                  <div className="col-span-full mt-2 sm:col-start-2">
                    <Button variant="outline" size="sm" onClick={() => void projectsQuery.refetch()}>
                      <RefreshCw aria-hidden="true" /> {t('Try again', 'Erneut versuchen')}
                    </Button>
                  </div>
                </Alert>
              </div>
            ) : projects.length === 0 ? (
              <Empty className="min-h-72 rounded-none p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Box aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{t('Deploy your first project', 'Dein erstes Projekt bereitstellen')}</EmptyTitle>
                  <EmptyDescription>{t('Connect a Git repository or upload a project folder. Shelter detects the appropriate runtime automatically.', 'Verbinde ein Git-Repository oder lade einen Projektordner hoch. Shelter erkennt die passende Laufzeit automatisch.')}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button asChild><Link to="/projects/new">{t('Create project', 'Projekt anlegen')} <ArrowRight aria-hidden="true" /></Link></Button>
                </EmptyContent>
              </Empty>
            ) : filteredProjects.length === 0 ? (
              <Empty className="min-h-56 rounded-none p-6">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><SearchX aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{t('No matching projects', 'Keine passenden Projekte')}</EmptyTitle>
                  <EmptyDescription>{t('Check the search term or search for a domain or repository.', 'Prüfe den Suchbegriff oder suche nach einer Domain beziehungsweise einem Repository.')}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearchQuery('');
                      setVisibleProjectCount(INITIAL_PROJECT_COUNT);
                    }}
                  >
                    {t('Reset search', 'Suche zurücksetzen')}
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <>
                {projectView === 'grid' ? (
                  <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
                    {visibleProjects.map((project) => <ProjectGridCard project={project} key={project.id} />)}
                  </div>
                ) : (
                  <ul className="divide-y">
                    {visibleProjects.map((project) => <ProjectRow project={project} key={project.id} />)}
                  </ul>
                )}
                <div className="flex flex-col items-start justify-between gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:px-6">
                  <p className="text-sm text-muted-foreground">{t(
                    '{visible} of {total} projects visible',
                    '{visible} von {total} Projekten sichtbar',
                    { visible: visibleProjects.length, total: filteredProjects.length },
                  )}</p>
                  {remainingProjects > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => setVisibleProjectCount((count) => count + INITIAL_PROJECT_COUNT)}
                    >
                      {t('Show {count} more', 'Weitere {count} anzeigen', { count: Math.min(INITIAL_PROJECT_COUNT, remainingProjects) })} <ArrowRight aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>

    </div>
  );
}
