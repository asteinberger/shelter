import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, ExternalLink, Save, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api/client';
import type { GitHubRepository, Project } from '../types';
import {
  gitHubRepositoryUrlFromFullName,
  hasGitHubProjectDraftChanges,
  shouldSynchronizeGitHubProjectDraft,
  trustedGitHubRepositoryUrl,
} from '../utils/github';
import { Button, Field, SelectField, StatusBadge } from './ui';
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
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { useI18n } from '@/i18n';
import { GitHubIcon } from './GitHubIcon';

function repositoryKey(repository: Pick<GitHubRepository, 'installationId' | 'id'>) {
  return `${repository.installationId}:${repository.id}`;
}

function comparableRepositoryUrl(value?: string) {
  return value?.trim().toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
}

export function ProjectGitHubConnection({
  project,
  disabled,
  onUpdated,
  onDirtyChange,
}: {
  project: Project;
  disabled?: boolean;
  onUpdated: (project: Project) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const connection = project.github ?? null;
  const initializedProject = useRef('');
  const initializedConnection = useRef('');
  const inferredRepository = useRef('');
  const initializedRepositoryKey = useRef('');
  const initializedBranch = useRef(connection?.branch ?? project.branch ?? 'main');
  const initializedAutoDeploy = useRef(connection?.autoDeploy ?? true);
  const [selectedRepositoryKey, setSelectedRepositoryKey] = useState('');
  const [repositorySearch, setRepositorySearch] = useState('');
  const [branch, setBranch] = useState(connection?.branch ?? project.branch ?? 'main');
  const [autoDeploy, setAutoDeploy] = useState(connection?.autoDeploy ?? true);

  const githubSettings = useQuery({
    queryKey: ['github-settings'],
    queryFn: api.github,
    retry: false,
    staleTime: 60_000,
  });
  const repositories = useQuery({
    queryKey: ['github-repositories'],
    queryFn: api.githubRepositories,
    enabled: Boolean(githubSettings.data?.connected && !connection),
    retry: false,
    staleTime: 60_000,
  });
  const selectedRepository = repositories.data?.find((repository) => repositoryKey(repository) === selectedRepositoryKey);
  const installationId = connection?.installationId ?? selectedRepository?.installationId;
  const repositoryId = connection?.repositoryId ?? selectedRepository?.id;
  const branches = useQuery({
    queryKey: ['github-branches', installationId, repositoryId],
    queryFn: ({ signal }) => api.githubBranches(installationId ?? '', repositoryId ?? '', signal),
    enabled: installationId !== undefined && repositoryId !== undefined,
    retry: false,
    staleTime: 60_000,
  });

  const connectionSignature = [
    connection?.installationId ?? '',
    connection?.repositoryId ?? '',
    connection?.branch ?? project.branch ?? 'main',
    connection?.autoDeploy ?? false,
  ].join(':');
  const localDraftDirty = hasGitHubProjectDraftChanges(
    { repositoryKey: selectedRepositoryKey, branch, autoDeploy },
    {
      repositoryKey: initializedRepositoryKey.current,
      branch: initializedBranch.current,
      autoDeploy: initializedAutoDeploy.current,
    },
  );

  useEffect(() => {
    const projectChanged = initializedProject.current !== project.id;
    if (!shouldSynchronizeGitHubProjectDraft({
      projectChanged,
      draftDirty: localDraftDirty,
      previousConnectionSignature: initializedConnection.current,
      connectionSignature,
    })) return;
    const nextBranch = connection?.branch ?? project.branch ?? 'main';
    const nextAutoDeploy = connection?.autoDeploy ?? true;
    initializedProject.current = project.id;
    initializedConnection.current = connectionSignature;
    initializedRepositoryKey.current = '';
    initializedBranch.current = nextBranch;
    initializedAutoDeploy.current = nextAutoDeploy;
    setSelectedRepositoryKey('');
    setRepositorySearch('');
    setBranch(nextBranch);
    setAutoDeploy(nextAutoDeploy);
  }, [connection?.autoDeploy, connection?.branch, connectionSignature, localDraftDirty, project.branch, project.id]);

  useEffect(() => {
    if (connection || !repositories.data?.length || inferredRepository.current === project.id) return;
    inferredRepository.current = project.id;
    const currentUrl = comparableRepositoryUrl(project.repositoryUrl);
    const match = repositories.data.find((repository) => (
      comparableRepositoryUrl(repository.cloneUrl) === currentUrl
      || comparableRepositoryUrl(repository.htmlUrl) === currentUrl
    ));
    if (!match) return;
    const nextRepositoryKey = repositoryKey(match);
    const nextBranch = project.branch ?? match.defaultBranch ?? 'main';
    initializedRepositoryKey.current = nextRepositoryKey;
    initializedBranch.current = nextBranch;
    setSelectedRepositoryKey(nextRepositoryKey);
    setBranch(nextBranch);
  }, [connection, project.branch, project.id, project.repositoryUrl, repositories.data]);

  const filteredRepositories = useMemo(() => {
    const needle = repositorySearch.trim().toLowerCase();
    if (!needle) return repositories.data ?? [];
    const matches = (repositories.data ?? []).filter((repository) => repository.fullName.toLowerCase().includes(needle));
    return selectedRepository && !matches.some((repository) => repository.id === selectedRepository.id)
      ? [selectedRepository, ...matches]
      : matches;
  }, [repositories.data, repositorySearch, selectedRepository]);
  const branchOptions = useMemo(() => {
    const options = branches.data ?? [];
    return branch && !options.some((candidate) => candidate.name === branch)
      ? [{ name: branch, sha: branch, protected: false }, ...options]
      : options;
  }, [branch, branches.data]);

  const save = useMutation({
    mutationFn: () => {
      if (installationId === undefined || repositoryId === undefined) throw new Error(t('Select a GitHub repository.', 'Wähle ein GitHub-Repository aus.'));
      return api.updateProjectGitHub(project.id, {
        installationId,
        repositoryId,
        branch: branch.trim(),
        autoDeploy,
      });
    },
    onSuccess: (updated) => {
      const nextBranch = updated.github?.branch ?? updated.branch ?? branch.trim();
      const nextAutoDeploy = updated.github?.autoDeploy ?? autoDeploy;
      initializedRepositoryKey.current = '';
      initializedBranch.current = nextBranch;
      initializedAutoDeploy.current = nextAutoDeploy;
      setSelectedRepositoryKey('');
      setBranch(nextBranch);
      setAutoDeploy(nextAutoDeploy);
      onUpdated(updated);
      toast.success(connection ? t('GitHub settings saved', 'GitHub-Einstellungen gespeichert') : t('Project connected to GitHub', 'Projekt mit GitHub verbunden'), {
        description: autoDeploy
          ? t('New commits on this branch automatically start a deployment.', 'Neue Commits auf diesem Branch starten automatisch ein Deployment.')
          : t('Deployments continue to be started manually.', 'Deployments werden weiterhin manuell gestartet.'),
      });
    },
    onError: (error) => toast.error(t('GitHub settings could not be saved', 'GitHub-Einstellungen konnten nicht gespeichert werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });
  const disconnect = useMutation({
    mutationFn: () => api.disconnectProjectGitHub(project.id),
    onSuccess: (updated) => {
      const nextBranch = updated.github?.branch ?? updated.branch ?? 'main';
      const nextAutoDeploy = updated.github?.autoDeploy ?? true;
      initializedRepositoryKey.current = '';
      initializedBranch.current = nextBranch;
      initializedAutoDeploy.current = nextAutoDeploy;
      setSelectedRepositoryKey('');
      setBranch(nextBranch);
      setAutoDeploy(nextAutoDeploy);
      onUpdated(updated);
      toast.success(t('GitHub auto-deploy disconnected', 'GitHub Auto-Deploy getrennt'), {
        description: t(
          'The source and deployment history remain. Private repositories require another GitHub connection before they can be deployed again.',
          'Quelle und Deployment-Historie bleiben erhalten. Private Repositories benötigen für weitere Deployments erneut eine GitHub-Verbindung.',
        ),
      });
    },
    onError: (error) => toast.error(t('GitHub could not be disconnected', 'GitHub konnte nicht getrennt werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  const busy = disabled || save.isPending || disconnect.isPending;
  const branchValid = branch.trim().length > 0 && branch.trim().length <= 160;
  const dirty = connection ? localDraftDirty : Boolean(selectedRepository);
  const repositoryName = connection?.fullName ?? selectedRepository?.fullName;
  const repositoryUrl = trustedGitHubRepositoryUrl(connection?.htmlUrl)
    ?? gitHubRepositoryUrlFromFullName(connection?.fullName);
  const navigationDirty = localDraftDirty;

  useEffect(() => {
    onDirtyChange?.(navigationDirty);
    return () => onDirtyChange?.(false);
  }, [navigationDirty, onDirtyChange]);

  return (
    <Card aria-labelledby="project-github-title">
      <CardHeader className="gap-4 border-b sm:grid-cols-[1fr_auto]">
        <div>
          <CardTitle id="project-github-title" className="flex items-center gap-2"><GitHubIcon className="size-5" aria-hidden="true" /> GitHub auto-deploy</CardTitle>
          <CardDescription className="mt-1">{t('Repository access, watched branch, and automatic deployments.', 'Repository-Zugriff, beobachteter Branch und automatische Deployments.')}</CardDescription>
        </div>
        <StatusBadge status={connection ? project.githubConnectionError ? 'error' : 'connected' : 'offline'} />
      </CardHeader>

      <CardContent className="grid gap-5">
        {project.githubConnectionError && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>{t('GitHub access for this project is interrupted', 'GitHub-Zugriff für dieses Projekt unterbrochen')}</AlertTitle>
            <AlertDescription>{project.githubConnectionError}</AlertDescription>
          </Alert>
        )}
        {githubSettings.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">{t('Loading GitHub connection …', 'GitHub-Verbindung wird geladen …')}</p>
        ) : githubSettings.isError || !githubSettings.data?.connected ? (
          <Alert variant={githubSettings.isError ? 'destructive' : 'default'}>
            <GitHubIcon aria-hidden="true" />
            <AlertTitle>{githubSettings.isError ? t('GitHub is unavailable', 'GitHub ist nicht erreichbar') : t('GitHub App not connected', 'GitHub App nicht verbunden')}</AlertTitle>
            <AlertDescription className="grid gap-3">
              <p>{githubSettings.isError
                ? (githubSettings.error instanceof Error ? githubSettings.error.message : t('Please try again.', 'Bitte versuche es erneut.'))
                : t('Set up the GitHub App for this Shelter server first.', 'Richte zuerst die GitHub App für diesen Shelter-Server ein.')}</p>
              <Button asChild size="sm" className="w-fit"><Link to="/settings/github">{t('Set up GitHub', 'GitHub einrichten')} <ArrowRight /></Link></Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {connection ? (
              <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-muted/20 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-background"><GitHubIcon className="size-4" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  {repositoryUrl ? (
                    <a href={repositoryUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium hover:underline hover:underline-offset-4">
                      <span className="truncate">{connection.fullName}</span><ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                    </a>
                  ) : <strong className="block truncate text-sm font-medium">{connection.fullName}</strong>}
                  <span className="mt-1 block text-xs text-muted-foreground">GitHub App · {t('Installation', 'Installation')} {connection.installationId}</span>
                </div>
                {connection.private === true && <Badge variant="secondary">{t('Private', 'Privat')}</Badge>}
              </div>
            ) : repositories.isLoading ? (
              <p className="text-sm text-muted-foreground" role="status">{t('Loading repositories …', 'Repositories werden geladen …')}</p>
            ) : repositories.isError ? (
              <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Repositories could not be loaded', 'Repositories konnten nicht geladen werden')}</AlertTitle><AlertDescription>{repositories.error instanceof Error ? repositories.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {(repositories.data?.length ?? 0) === 0 && (
                  <Alert className="sm:col-span-2">
                    <GitHubIcon aria-hidden="true" />
                    <AlertTitle>{t('No repositories shared', 'Keine Repositories freigegeben')}</AlertTitle>
                    <AlertDescription className="grid gap-3">
                      <p>{t('Add this repository to the existing GitHub installation.', 'Erweitere die bestehende GitHub-Installation um dieses Repository.')}</p>
                      <Button asChild size="sm" variant="outline" className="w-fit"><Link to="/settings/github">{t('Manage installation', 'Installation verwalten')} <ArrowRight /></Link></Button>
                    </AlertDescription>
                  </Alert>
                )}
                <Field label={t('Search repositories', 'Repositories durchsuchen')} value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} placeholder={t('Organization or repository', 'Organisation oder Repository')} disabled={busy} />
                <SelectField
                  label={t('Repository', 'Repository')}
                  value={selectedRepositoryKey}
                  onChange={(event) => {
                    const nextKey = event.target.value;
                    const repository = repositories.data?.find((candidate) => repositoryKey(candidate) === nextKey);
                    setSelectedRepositoryKey(nextKey);
                    if (repository) setBranch(repository.defaultBranch || 'main');
                  }}
                  disabled={busy || filteredRepositories.length === 0}
                >
                  <option value="">{t('Select repository', 'Repository auswählen')}</option>
                  {filteredRepositories.map((repository) => <option value={repositoryKey(repository)} key={repositoryKey(repository)}>{repository.fullName}{repository.private ? ` · ${t('private', 'privat')}` : ''}</option>)}
                </SelectField>
              </div>
            )}

            {(connection || selectedRepository) && (
              <div className="grid gap-5 sm:grid-cols-2">
                {branches.isError ? (
                  <Field label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)} error={!branchValid ? t('The branch must be between 1 and 160 characters.', 'Der Branch muss zwischen 1 und 160 Zeichen lang sein.') : undefined} hint={t('Branches could not be loaded; enter the name manually.', 'Branches konnten nicht geladen werden; der Name kann manuell eingegeben werden.')} disabled={busy} />
                ) : (
                  <SelectField label="Branch" value={branch} onChange={(event) => setBranch(event.target.value)} error={!branchValid ? t('The branch must be between 1 and 160 characters.', 'Der Branch muss zwischen 1 und 160 Zeichen lang sein.') : undefined} disabled={busy || branches.isLoading}>
                    {branches.isLoading && <option value={branch}>{t('Loading branches …', 'Branches werden geladen …')}</option>}
                    {branchOptions.map((candidate) => <option value={candidate.name} key={candidate.name}>{candidate.name}{candidate.protected ? ` · ${t('protected', 'geschützt')}` : ''}</option>)}
                  </SelectField>
                )}
                <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 p-4">
                  <div>
                    <Label htmlFor="project-github-auto-deploy">{t('Automatically deploy GitHub pushes', 'Bei GitHub-Push automatisch deployen')}</Label>
                    <p id="project-github-auto-deploy-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                      {autoDeploy
                        ? <>{t('New pushes to', 'Neue Pushes auf')} <span className="font-mono text-foreground">{branch || t('this branch', 'diesen Branch')}</span> {t('start automatically.', 'starten automatisch.')}</>
                        : <>{t('Disabled. The header button still fetches', 'Ausgeschaltet. Der Header-Button lädt')} <span className="font-mono text-foreground">{connection?.branch ?? project.branch ?? 'main'}</span> {t('fresh and deploys manually.', 'weiterhin frisch und deployed manuell.')}</>}
                    </p>
                  </div>
                  <Switch
                    id="project-github-auto-deploy"
                    checked={autoDeploy}
                    onCheckedChange={setAutoDeploy}
                    disabled={busy}
                    aria-describedby="project-github-auto-deploy-description"
                  />
                </div>
              </div>
            )}

            {repositoryName && !connection && (
              <p className="text-xs text-muted-foreground">{t('Selected:', 'Ausgewählt:')} <strong className="font-medium text-foreground">{repositoryName}</strong></p>
            )}
            {save.isError && <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('GitHub settings could not be saved', 'GitHub-Einstellungen konnten nicht gespeichert werden')}</AlertTitle><AlertDescription>{save.error instanceof Error ? save.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>}
          </>
        )}
      </CardContent>

      {(connection || (githubSettings.data?.connected && selectedRepository)) && (
        <CardFooter className="flex flex-col-reverse items-stretch justify-between gap-3 border-t bg-muted/20 sm:flex-row sm:items-center">
          {connection ? (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy}><Unplug /> {t('Disconnect', 'Verknüpfung lösen')}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive"><Unplug /></AlertDialogMedia>
                  <AlertDialogTitle>{t('Disconnect GitHub?', 'GitHub-Verknüpfung lösen?')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('Auto-deploy will be disabled. The source and previous deployments remain; private repositories need a GitHub connection before further deployments.', 'Auto-Deploy wird deaktiviert. Quelle und bisherige Deployments bleiben erhalten; private Repositories benötigen für weitere Deployments erneut eine GitHub-Verbindung.')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>{t('Cancel', 'Abbrechen')}</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => disconnect.mutate()} disabled={busy}>{t('Disconnect', 'Verknüpfung lösen')}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : <span className="text-xs text-muted-foreground">{t('The running version remains unchanged until the next deployment.', 'Die laufende Version bleibt bis zum nächsten Deployment unverändert.')}</span>}
          <Button type="button" onClick={() => save.mutate()} loading={save.isPending} disabled={busy || !dirty || !branchValid}>
            {!save.isPending && <Save />} {connection ? t('Save GitHub', 'GitHub speichern') : t('Connect GitHub', 'Mit GitHub verbinden')}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
