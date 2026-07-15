import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { NavigationGuard } from '../components/NavigationGuard';
import { ProjectSourceUpload } from '../components/ProjectSourceUpload';
import { Button, ErrorState, PageIntro, Skeleton, StatusBadge } from '../components/ui';
import { BRAND_NAME } from '../lib/brand';
import { useI18n } from '@/i18n';

export function UploadProjectSourcePage() {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadDirty, setUploadDirty] = useState(false);
  const [queuedDeploymentId, setQueuedDeploymentId] = useState<string>();
  const projectQuery = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    enabled: Boolean(id),
    refetchInterval: 20_000,
  });
  const project = projectQuery.data;

  useEffect(() => {
    document.title = project
      ? `${t('New version', 'Neue Version')} · ${project.name} · ${BRAND_NAME}`
      : `${t('New version', 'Neue Version')} · ${BRAND_NAME}`;
  }, [project, t]);

  useEffect(() => {
    if (!queuedDeploymentId || uploadPending) return;
    navigate(`/projects/${id}/deployments/${queuedDeploymentId}`, { replace: true });
  }, [id, navigate, queuedDeploymentId, uploadPending]);

  if (projectQuery.isLoading) {
    return (
      <div className="grid gap-6" role="status" aria-label={t('Loading project and upload form', 'Projekt und Upload-Formular werden geladen')}>
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-28" />
        <Skeleton className="h-[34rem]" />
      </div>
    );
  }

  if (projectQuery.isError || !project) {
    return (
      <div className="grid gap-6">
        <Button asChild variant="ghost" className="w-fit"><Link to="/projects"><ArrowLeft /> {t('All projects', 'Alle Projekte')}</Link></Button>
        <ErrorState
          title={t('Project not found', 'Projekt nicht gefunden')}
          message={projectQuery.error instanceof Error ? projectQuery.error.message : t('This project is unavailable.', 'Dieses Projekt ist nicht verfügbar.')}
          action={<Button onClick={() => projectQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  if (project.sourceType !== 'upload') {
    return (
      <div className="grid gap-6">
        <Button asChild variant="ghost" className="-ml-2 w-fit min-w-0 max-w-[calc(100%+0.5rem)] text-muted-foreground">
          <Link to={`/projects/${project.id}?tab=deployments`}>
            <ArrowLeft />
            <span className="min-w-0 truncate">{project.name}</span>
            <span className="shrink-0">· {t('Deployments', 'Deployments')}</span>
          </Link>
        </Button>
        <ErrorState
          title={t('Upload unavailable for this project', 'Upload für dieses Projekt nicht verfügbar')}
          message={t('This project is built from a Git repository. Start a new deployment from the current branch instead.', 'Dieses Projekt wird aus einem Git-Repository gebaut. Starte dort ein neues Deployment aus der aktuellen Branch.')}
          action={<Button asChild><Link to={`/projects/${project.id}?tab=deployments`}>{t('Go to deployments', 'Zu den Deployments')}</Link></Button>}
        />
      </div>
    );
  }

  const deletionFailed = project.status === 'deletion_failed' || project.deletionStatus === 'failed';
  const supportsStaticBasePath = project.buildType !== 'node' && project.buildType !== 'dockerfile';

  return (
    <div className="grid min-w-0 gap-6 sm:gap-7">
      <NavigationGuard
        when={uploadPending || uploadDirty}
        locked={uploadPending}
        title={uploadPending ? t('Upload in progress', 'Upload läuft noch') : t('Upload not started', 'Upload noch nicht gestartet')}
        description={uploadPending
          ? t('Stay on this page until every file is transferred and the deployment has been created.', 'Bitte bleibe auf dieser Seite, bis alle Dateien übertragen und das Deployment angelegt wurden.')
          : t('Leaving discards your file selection and unsaved hosting-path choice.', 'Beim Verlassen gehen deine Dateiauswahl und die noch nicht übernommene Hosting-Pfadwahl verloren.')}
      />

      <Button asChild variant="ghost" className="-ml-2 w-fit min-w-0 max-w-[calc(100%+0.5rem)] text-muted-foreground">
        <Link to={`/projects/${project.id}?tab=deployments`}>
          <ArrowLeft />
          <span className="min-w-0 truncate">{project.name}</span>
          <span className="shrink-0">· {t('Deployments', 'Deployments')}</span>
        </Link>
      </Button>

      <PageIntro
        eyebrow={<><StatusBadge status={project.status} /><span>{t('New version', 'Neue Version')}</span></>}
        title={project.name}
        description={t('Replace the saved upload source. The current production version stays online until the new health check passes.', 'Ersetze die gespeicherte Upload-Quelle. Die aktuelle Produktionsversion bleibt bis zum erfolgreichen Healthcheck online.')}
      />

      <ProjectSourceUpload
        projectId={project.id}
        projectName={project.name}
        disabled={project.status === 'deploying' || deletionFailed}
        onClose={() => navigate(`/projects/${project.id}?tab=deployments`)}
        onPendingChange={setUploadPending}
        onDirtyChange={setUploadDirty}
        initialStaticBasePath={project.staticBasePath}
        supportsStaticBasePath={supportsStaticBasePath}
        currentRootDirectory={project.rootDirectory}
        currentBuildType={project.buildType}
        currentPort={project.port}
        currentEnvironmentKeys={project.environmentKeys}
        onQueued={(deployment) => {
          void queryClient.invalidateQueries({ queryKey: ['project', project.id] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['overview'] });
          setQueuedDeploymentId(deployment.id);
        }}
      />

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <UploadCloud className="size-3.5" /> {t('After the upload, Shelter automatically opens the live output of the new deployment.', 'Nach dem Upload öffnet Shelter automatisch die Live-Ausgabe des neuen Deployments.')}
      </p>
    </div>
  );
}
