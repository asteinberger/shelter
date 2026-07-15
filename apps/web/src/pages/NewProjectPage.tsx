import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  FileArchive,
  Files,
  FolderOpen,
  Github,
  LoaderCircle,
  GitBranch,
  PackageOpen,
  Plus,
  ShieldCheck,
  TriangleAlert,
  UploadCloud,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api/client';
import { NavigationGuard } from '../components/NavigationGuard';
import { ProjectAnalysisCard, type ProjectAnalysisStatus } from '../components/ProjectAnalysisCard';
import { StaticBasePathControl } from '../components/StaticBasePathControl';
import { Button, Field, PageIntro, SelectField } from '../components/ui';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Progress } from '../components/ui/progress';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Switch } from '../components/ui/switch';
import type {
  GitHubProjectInput,
  GitProjectInput,
  NewProjectEnvironmentVariable,
  ProjectSourceAnalysis,
  UploadProjectInput,
} from '../types';
import { archiveFolder, type ArchiveProgress } from '../utils/archive';
import { isLikelyFileStorageFolder } from '../utils/file-storage';
import { collectFolderAnalysisFiles, collectZipAnalysisFiles } from '../utils/project-analysis-input';
import {
  AnalysisRequestCoordinator,
  analysisApplication,
  mergeDetectedBuildConfig,
  missingDetectedEnvironmentKeys,
  recommendedAnalysisApplicationId,
  type DetectableBuildConfigField,
} from '../utils/project-analysis';
import { staticBasePathError } from '../utils/static-base-path';
import { cn } from '@/lib/utils';
import { localize, useI18n } from '@/i18n';

type SourceMode = 'git' | 'upload';
type UploadKind = 'zip' | 'folder';
type GitSourceMode = 'github' | 'url';

interface BuildConfig {
  name: string;
  rootDirectory: string;
  buildType: 'auto' | 'dockerfile' | 'node' | 'static';
  dockerfilePath: string;
  healthcheckPath: string;
  port: string;
}

interface EnvironmentEntry extends NewProjectEnvironmentVariable {
  id: number;
}

interface EnvironmentEntryErrors {
  key?: string;
  value?: string;
}

interface LocalAnalysisState {
  status: ProjectAnalysisStatus;
  analysis?: ProjectSourceAnalysis;
}

const initialConfig: BuildConfig = {
  name: '',
  rootDirectory: '',
  buildType: 'auto',
  dockerfilePath: 'Dockerfile',
  healthcheckPath: '/',
  port: '3000',
};

const reservedEnvironmentKeys = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);
const MAX_PROJECT_NAME_LENGTH = 80;
const MAX_BRANCH_LENGTH = 160;
const MAX_RELATIVE_PATH_LENGTH = 240;
const MAX_HEALTHCHECK_PATH_LENGTH = 200;
const MAX_ENVIRONMENT_VARIABLES = 200;
const MAX_ENVIRONMENT_KEY_LENGTH = 100;
const MAX_ENVIRONMENT_VALUE_LENGTH = 65_536;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const utf8Encoder = new TextEncoder();

function projectNameFromFile(fileName: string) {
  return fileName.replace(/\.zip$/i, '').replace(/[-_]+/g, ' ').trim();
}

function projectNameFromRepository(repository: string) {
  return repository.trim().replace(/\/$/, '').split('/').pop()?.replace(/\.git$/i, '') ?? '';
}

function githubRepositoryKey(installationId: string | number, repositoryId: string | number) {
  return `${installationId}:${repositoryId}`;
}

function configPayload(config: BuildConfig) {
  return {
    name: config.name.trim(),
    rootDirectory: config.rootDirectory.trim() || undefined,
    buildType: config.buildType,
    dockerfilePath: config.buildType === 'dockerfile' ? config.dockerfilePath.trim() || 'Dockerfile' : undefined,
    healthcheckPath: config.healthcheckPath.trim() || '/',
    port: config.port ? Number(config.port) : undefined,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function repositoryUrlError(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return localize('Enter the HTTPS URL of a public Git repository.', 'Gib die HTTPS-URL eines öffentlichen Git-Repositorys ein.');

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return localize('Use an HTTPS URL; SSH and HTTP sources are not supported.', 'Verwende eine HTTPS-URL; SSH- und HTTP-Quellen werden nicht unterstützt.');
    if (!url.hostname) return localize('The repository URL needs a valid hostname.', 'Die Repository-URL benötigt einen gültigen Hostnamen.');
    if (url.username || url.password) return localize('Remove credentials from the URL.', 'Entferne Zugangsdaten aus der URL.');
  } catch {
    return localize('Enter a complete URL, for example https://github.com/acme/website.git.', 'Gib eine vollständige URL ein, zum Beispiel https://github.com/acme/website.git.');
  }

  return undefined;
}

function relativePathError(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_RELATIVE_PATH_LENGTH) {
    return localize(
      '{label} may contain at most {count} characters.',
      '{label} darf höchstens {count} Zeichen lang sein.',
      { label, count: MAX_RELATIVE_PATH_LENGTH },
    );
  }

  const normalized = trimmed.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return localize('{label} must be relative and cannot contain “..”.', '{label} muss relativ sein und darf kein „..“ enthalten.', { label });
  }
  return undefined;
}

function environmentSizeInBytes(environment: EnvironmentEntry[]) {
  return environment.reduce((total, variable) => (
    total + utf8Encoder.encode(variable.key).byteLength + utf8Encoder.encode(variable.value).byteLength + 2
  ), 0);
}

export function NewProjectPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const zipInputId = useId();
  const folderInputId = useId();
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const environmentId = useRef(0);
  const projectNameManuallyEdited = useRef(false);
  const manuallyEditedBuildFields = useRef(new Set<DetectableBuildConfigField>());
  const analysisRequests = useRef(new AnalysisRequestCoordinator());
  const [sourceMode, setSourceMode] = useState<SourceMode>('git');
  const [gitSourceMode, setGitSourceMode] = useState<GitSourceMode>('github');
  const [uploadKind, setUploadKind] = useState<UploadKind>('zip');
  const [config, setConfig] = useState<BuildConfig>(initialConfig);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [selectedRepositoryKey, setSelectedRepositoryKey] = useState('');
  const [repositorySearch, setRepositorySearch] = useState('');
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [staticBasePath, setStaticBasePath] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentEntry[]>([]);
  const [progress, setProgress] = useState<{ percent: number; label: string; detail?: string } | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState('');
  const [environmentOpen, setEnvironmentOpen] = useState('');
  const [projectCreated, setProjectCreated] = useState(false);
  const [localAnalysis, setLocalAnalysis] = useState<LocalAnalysisState>({ status: 'idle' });
  const [selectedApplicationId, setSelectedApplicationId] = useState('');
  const [appliedAnalysisIdentity, setAppliedAnalysisIdentity] = useState('');

  const githubSettings = useQuery({
    queryKey: ['github-settings'],
    queryFn: api.github,
    enabled: sourceMode === 'git',
    retry: false,
    staleTime: 60_000,
  });
  const githubRepositories = useQuery({
    queryKey: ['github-repositories'],
    queryFn: api.githubRepositories,
    enabled: sourceMode === 'git' && gitSourceMode === 'github' && Boolean(githubSettings.data?.connected),
    retry: false,
    staleTime: 60_000,
  });
  const selectedRepository = githubRepositories.data?.find((repository) => (
    githubRepositoryKey(repository.installationId, repository.id) === selectedRepositoryKey
  ));
  const githubBranches = useQuery({
    queryKey: ['github-branches', selectedRepository?.installationId, selectedRepository?.id],
    queryFn: ({ signal }) => api.githubBranches(
      selectedRepository?.installationId ?? '',
      selectedRepository?.id ?? '',
      signal,
    ),
    enabled: Boolean(selectedRepository),
    retry: false,
    staleTime: 60_000,
  });
  const githubAnalysis = useQuery({
    queryKey: [
      'github-project-analysis',
      selectedRepository?.installationId,
      selectedRepository?.id,
      branch.trim(),
    ],
    queryFn: ({ signal }) => api.githubRepositoryAnalysis(
      selectedRepository?.installationId ?? '',
      selectedRepository?.id ?? '',
      branch.trim(),
      signal,
    ),
    enabled: sourceMode === 'git'
      && gitSourceMode === 'github'
      && Boolean(selectedRepository)
      && Boolean(branch.trim()),
    retry: 1,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const analyzeUpload = useMutation({
    mutationFn: ({
      files,
      signal,
    }: {
      files: Array<{ path: string; size?: number; content?: string }>;
      signal: AbortSignal;
    }) => api.analyzeProject(files, signal),
  });

  function updateConfig(field: keyof BuildConfig, value: string, manuallyEdited = true) {
    if (manuallyEdited && field !== 'name') manuallyEditedBuildFields.current.add(field);
    setConfig((current) => ({ ...current, [field]: value }));
  }

  function applyDetectedApplication(applicationId: string, analysis: ProjectSourceAnalysis) {
    const application = analysisApplication(analysis, applicationId);
    if (!application) return;
    setSelectedApplicationId(application.id);
    setConfig((current) => mergeDetectedBuildConfig(current, application, manuallyEditedBuildFields.current));
  }

  function cancelLocalAnalysis() {
    analysisRequests.current.cancel();
    setLocalAnalysis({ status: 'idle' });
  }

  function resetDetectedBuildConfig() {
    setConfig((current) => ({
      ...current,
      ...(!manuallyEditedBuildFields.current.has('rootDirectory') ? { rootDirectory: initialConfig.rootDirectory } : {}),
      ...(!manuallyEditedBuildFields.current.has('buildType') ? { buildType: initialConfig.buildType } : {}),
      ...(!manuallyEditedBuildFields.current.has('dockerfilePath') ? { dockerfilePath: initialConfig.dockerfilePath } : {}),
      ...(!manuallyEditedBuildFields.current.has('healthcheckPath') ? { healthcheckPath: initialConfig.healthcheckPath } : {}),
      ...(!manuallyEditedBuildFields.current.has('port') ? { port: initialConfig.port } : {}),
    }));
  }

  function changeSourceMode(nextMode: SourceMode) {
    if (nextMode === sourceMode) return;
    cancelLocalAnalysis();
    setSelectedApplicationId('');
    resetDetectedBuildConfig();
    setSourceMode(nextMode);
    setProgress(null);
    createProject.reset();
    if (nextMode === 'upload') {
      if (zipFile) void runUploadAnalysis('zip', zipFile);
      else if (folderFiles.length) void runUploadAnalysis('folder', folderFiles);
    } else {
      void queryClient.cancelQueries({ queryKey: ['github-project-analysis'] });
    }
  }

  function resetGitAnalysis() {
    setSelectedApplicationId('');
    resetDetectedBuildConfig();
    void queryClient.cancelQueries({ queryKey: ['github-project-analysis'] });
  }

  function retrySourceAnalysis() {
    if (sourceMode === 'git') {
      void githubAnalysis.refetch();
    } else if (zipFile) {
      void runUploadAnalysis('zip', zipFile);
    } else if (folderFiles.length) {
      void runUploadAnalysis('folder', folderFiles);
    }
  }

  function showDetectedSettings() {
    setAdvancedOpen('advanced');
    window.setTimeout(() => document.getElementById('advanced-step-title')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
  }

  async function runUploadAnalysis(kind: UploadKind, input: File | File[]) {
    const request = analysisRequests.current.begin();
    setLocalAnalysis({ status: 'analyzing' });
    setSelectedApplicationId('');

    try {
      const files = kind === 'zip'
        ? await collectZipAnalysisFiles(input as File, { signal: request.signal })
        : await collectFolderAnalysisFiles(input as File[], { signal: request.signal });
      if (!analysisRequests.current.isCurrent(request.version)) return;

      const analysis = await analyzeUpload.mutateAsync({ files, signal: request.signal });
      if (!analysisRequests.current.isCurrent(request.version)) return;
      setLocalAnalysis({ status: 'ready', analysis });
    } catch (error) {
      if (!analysisRequests.current.isCurrent(request.version) || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLocalAnalysis({ status: 'error' });
    }
  }

  function selectZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setZipFile(file);
    setFolderFiles([]);
    resetDetectedBuildConfig();
    if (file && !projectNameManuallyEdited.current) updateConfig('name', projectNameFromFile(file.name), false);
    if (file) void runUploadAnalysis('zip', file);
    else cancelLocalAnalysis();
  }

  function selectFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setFolderFiles(files);
    setZipFile(null);
    resetDetectedBuildConfig();
    const root = files[0]?.webkitRelativePath.split('/')[0];
    if (root && !projectNameManuallyEdited.current) updateConfig('name', root.replace(/[-_]+/g, ' '), false);
    if (files.length) void runUploadAnalysis('folder', files);
    else cancelLocalAnalysis();
  }

  function resetFile() {
    cancelLocalAnalysis();
    resetDetectedBuildConfig();
    setZipFile(null);
    setFolderFiles([]);
    if (zipInput.current) zipInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }

  function changeUploadKind(nextKind: UploadKind) {
    if (nextKind === uploadKind) return;
    resetFile();
    setUploadKind(nextKind);
  }

  function addEnvironmentVariable() {
    if (environment.length >= MAX_ENVIRONMENT_VARIABLES) return;
    environmentId.current += 1;
    const id = environmentId.current;
    setEnvironment((current) => current.length >= MAX_ENVIRONMENT_VARIABLES
      ? current
      : [...current, { id, key: '', value: '' }]);
  }

  function updateEnvironmentVariable(id: number, field: 'key' | 'value', value: string) {
    setEnvironment((current) => current.map((variable) => (
      variable.id === id
        ? { ...variable, [field]: field === 'key' ? value.toUpperCase().replace(/[^A-Z0-9_]/g, '') : value }
        : variable
    )));
  }

  function environmentPayload(): NewProjectEnvironmentVariable[] | undefined {
    if (environment.length === 0) return undefined;
    return environment.map(({ key, value }) => ({ key: key.trim(), value }));
  }

  const createProject = useMutation({
    onMutate: () => setProjectCreated(false),
    mutationFn: async () => {
      if (sourceMode === 'git') {
        if (gitSourceMode === 'github') {
          if (!selectedRepository) throw new Error(t('Select a GitHub repository.', 'Bitte wähle ein GitHub-Repository aus.'));
          const input: GitHubProjectInput = {
            ...configPayload(config),
            repositoryId: selectedRepository.id,
            installationId: selectedRepository.installationId,
            branch: branch.trim() || selectedRepository.defaultBranch,
            autoDeploy,
            environment: environmentPayload(),
            staticBasePath: staticPathSupported ? staticBasePath : null,
          };
          return api.createGitHubProject(input);
        }
        const input: GitProjectInput = {
          ...configPayload(config),
          repositoryUrl: repositoryUrl.trim(),
          branch: branch.trim() || 'main',
          environment: environmentPayload(),
          staticBasePath: staticPathSupported ? staticBasePath : null,
        };
        return api.createGitProject(input);
      }

      let file = zipFile;
      if (uploadKind === 'folder') {
        setProgress({ percent: 2, label: t('Preparing folder', 'Ordner wird vorbereitet'), detail: t('{count} files', '{count} Dateien', { count: folderFiles.length }) });
        file = await archiveFolder(folderFiles, (archiveProgress: ArchiveProgress) => {
          const ratio = archiveProgress.totalBytes > 0
            ? archiveProgress.processedBytes / archiveProgress.totalBytes
            : archiveProgress.current / archiveProgress.total;
          setProgress({
            percent: 2 + ratio * 16,
            label: t('Archiving folder', 'Ordner wird gepackt'),
            detail: t(
              '{processed} / {totalBytes} · File {current} of {total}',
              '{processed} / {totalBytes} · Datei {current} von {total}',
              {
                processed: formatBytes(archiveProgress.processedBytes),
                totalBytes: formatBytes(archiveProgress.totalBytes),
                current: archiveProgress.current,
                total: archiveProgress.total,
              },
            ),
          });
        });
      }
      if (!file) throw new Error(t('Select a ZIP archive or project folder.', 'Bitte wähle ein ZIP-Archiv oder einen Projektordner aus.'));

      setProgress({ percent: 20, label: t('Preparing upload', 'Upload wird vorbereitet'), detail: formatBytes(file.size) });

      const metadata: UploadProjectInput = {
        ...configPayload(config),
        sourceLabel: uploadKind === 'folder'
          ? folderFiles[0]?.webkitRelativePath.split('/')[0]
          : file.name,
        environment: environmentPayload(),
        staticBasePath: staticPathSupported ? staticBasePath : null,
      };
      return api.createUploadProject(metadata, file, (upload) => {
        const ratio = upload.totalBytes ? upload.uploadedBytes / upload.totalBytes : 0;
        if (upload.phase === 'verifying') {
          setProgress({ percent: 96, label: t('Verifying archive', 'Archiv wird geprüft'), detail: t('Validating ZIP contents and file paths', 'ZIP-Inhalt und Dateipfade werden validiert') });
          return;
        }
        if (upload.phase === 'queueing') {
          setProgress({ percent: 99, label: t('Creating project', 'Projekt wird angelegt'), detail: t('Queuing deployment', 'Deployment wird in die Warteschlange gestellt') });
          return;
        }
        setProgress({
          percent: 20 + ratio * 78,
          label: t('Uploading project', 'Projekt wird hochgeladen'),
          detail: `${formatBytes(upload.uploadedBytes)} / ${formatBytes(upload.totalBytes)} · Chunk ${upload.chunk}/${upload.chunks}`,
        });
      });
    },
    onSuccess: (project) => {
      setProjectCreated(true);
      setProgress({ percent: 100, label: t('Project created', 'Projekt angelegt'), detail: t('Preparing deployment', 'Deployment wird vorbereitet') });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('Project created', 'Projekt wurde angelegt'), {
        description: t('The first build is now being prepared.', 'Der erste Build wird jetzt vorbereitet.'),
      });
      window.setTimeout(() => navigate(`/projects/${project.id}`), 350);
    },
    onError: (error) => {
      setProgress(null);
      toast.error(t('Project could not be created', 'Projekt konnte nicht angelegt werden'), {
        description: error instanceof Error ? error.message : t('Check your entries and try again.', 'Bitte prüfe deine Angaben und versuche es erneut.'),
      });
    },
  });

  const formDirty = useMemo(() => (
    sourceMode !== 'git'
    || gitSourceMode !== 'github'
    || uploadKind !== 'zip'
    || repositoryUrl.length > 0
    || branch !== 'main'
    || selectedRepositoryKey.length > 0
    || !autoDeploy
    || zipFile !== null
    || folderFiles.length > 0
    || staticBasePath !== null
    || environment.length > 0
    || Object.entries(initialConfig).some(([key, initialValue]) => (
      config[key as keyof BuildConfig] !== initialValue
    ))
  ), [
    autoDeploy,
    branch,
    config,
    environment.length,
    folderFiles.length,
    gitSourceMode,
    repositoryUrl,
    selectedRepositoryKey,
    sourceMode,
    staticBasePath,
    uploadKind,
    zipFile,
  ]);
  const navigationProtected = createProject.isPending || (formDirty && !projectCreated);

  useEffect(() => {
    if (!navigationProtected) return undefined;
    const preventNavigation = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventNavigation);
    return () => window.removeEventListener('beforeunload', preventNavigation);
  }, [navigationProtected]);

  useEffect(() => {
    if (!createProject.isError) return;
    window.requestAnimationFrame(() => {
      const error = document.getElementById('create-project-error');
      error?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      error?.focus({ preventScroll: true });
    });
  }, [createProject.isError]);

  const githubAnalysisEligible = sourceMode === 'git'
    && gitSourceMode === 'github'
    && Boolean(selectedRepository)
    && Boolean(branch.trim());
  const analysisStatus: ProjectAnalysisStatus = sourceMode === 'upload'
    ? localAnalysis.status
    : githubAnalysisEligible
      ? githubAnalysis.isFetching && !githubAnalysis.data
        ? 'analyzing'
        : githubAnalysis.isError
          ? 'error'
          : githubAnalysis.data
            ? 'ready'
            : 'idle'
      : 'idle';
  const activeAnalysis = sourceMode === 'upload' ? localAnalysis.analysis : githubAnalysis.data;
  const activeAnalysisIdentity = activeAnalysis
    ? sourceMode === 'upload'
      ? `upload:${zipFile?.name ?? folderFiles[0]?.webkitRelativePath.split('/')[0] ?? ''}:${activeAnalysis.fingerprint}`
      : `github:${selectedRepositoryKey}:${branch.trim()}:${activeAnalysis.fingerprint}`
    : '';
  const analysisInProgress = analysisStatus === 'analyzing'
    || Boolean(activeAnalysisIdentity && appliedAnalysisIdentity !== activeAnalysisIdentity);

  useEffect(() => {
    if (!activeAnalysisIdentity || !activeAnalysis) {
      setSelectedApplicationId('');
      setAppliedAnalysisIdentity('');
      return;
    }
    const applicationId = recommendedAnalysisApplicationId(activeAnalysis);
    if (applicationId) applyDetectedApplication(applicationId, activeAnalysis);
    setAppliedAnalysisIdentity(activeAnalysisIdentity);
  // The stable identity deliberately drives this effect; query metadata must not re-apply detected values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAnalysisIdentity]);

  useEffect(() => () => analysisRequests.current.cancel(), []);

  const selectedApplication = analysisApplication(activeAnalysis, selectedApplicationId)
    ?? activeAnalysis?.applications[0]
    ?? null;
  const detectedMissingEnvironmentKeys = useMemo(() => missingDetectedEnvironmentKeys(
    selectedApplication?.environmentKeys ?? [],
    environment.map((variable) => variable.key),
    reservedEnvironmentKeys,
  ), [environment, selectedApplication]);
  const addableDetectedEnvironmentKeys = detectedMissingEnvironmentKeys.slice(
    0,
    Math.max(0, MAX_ENVIRONMENT_VARIABLES - environment.length),
  );

  function addDetectedEnvironmentVariables() {
    const keys = addableDetectedEnvironmentKeys;
    if (!keys.length) return;
    const entries = keys.map((key) => {
      environmentId.current += 1;
      return { id: environmentId.current, key, value: '' };
    });
    setEnvironment((current) => [...current, ...entries]);
    setEnvironmentOpen('environment');
  }

  const folderSize = folderFiles.reduce((sum, file) => sum + file.size, 0);
  const hasUpload = Boolean(zipFile || folderFiles.length);
  const fileStorageDetected = useMemo(() => (
    selectedApplication?.rendering === 'files'
    || (
      sourceMode === 'upload'
      && uploadKind === 'folder'
      && config.buildType === 'auto'
      && isLikelyFileStorageFolder(folderFiles)
    )
  ), [config.buildType, folderFiles, selectedApplication?.rendering, sourceMode, uploadKind]);
  const filteredRepositories = useMemo(() => {
    const needle = repositorySearch.trim().toLowerCase();
    if (!needle) return githubRepositories.data ?? [];
    const matches = (githubRepositories.data ?? []).filter((repository) => (
      repository.fullName.toLowerCase().includes(needle)
      || repository.owner.toLowerCase().includes(needle)
    ));
    return selectedRepository && !matches.some((repository) => repository.id === selectedRepository.id)
      ? [selectedRepository, ...matches]
      : matches;
  }, [githubRepositories.data, repositorySearch, selectedRepository]);
  const staticPathSupported = config.buildType !== 'node'
    && config.buildType !== 'dockerfile';

  const environmentErrors = useMemo<EnvironmentEntryErrors[]>(() => {
    const keys = environment.map((variable) => variable.key.trim());
    return environment.map((variable, index) => {
      const key = variable.key.trim();
      let keyError: string | undefined;
      if (!key) keyError = t('Enter a variable name or remove this row.', 'Gib einen Variablennamen ein oder entferne diese Zeile.');
      else if (key.length > MAX_ENVIRONMENT_KEY_LENGTH) keyError = t('The key may contain at most {count} characters.', 'Der Key darf höchstens {count} Zeichen lang sein.', { count: MAX_ENVIRONMENT_KEY_LENGTH });
      else if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) keyError = t('The key must begin with a letter or _.', 'Der Key muss mit einem Buchstaben oder _ beginnen.');
      else if (reservedEnvironmentKeys.has(key)) keyError = t('{key} is managed by Shelter and cannot be set here.', '{key} wird von Shelter verwaltet und kann hier nicht gesetzt werden.', { key });
      else if (keys.indexOf(key) !== index) keyError = t('{key} occurs more than once.', '{key} ist doppelt vorhanden.', { key });

      return {
        key: keyError,
        value: variable.value.length > MAX_ENVIRONMENT_VALUE_LENGTH
          ? t('The value may contain at most {count} characters.', 'Der Wert darf höchstens {count} Zeichen lang sein.', { count: MAX_ENVIRONMENT_VALUE_LENGTH.toLocaleString(locale === 'de' ? 'de-DE' : 'en-US') })
          : undefined,
      };
    });
  }, [environment, locale, t]);

  const environmentBytes = useMemo(() => environmentSizeInBytes(environment), [environment]);
  const environmentGlobalError = environment.length > MAX_ENVIRONMENT_VARIABLES
    ? t('At most {count} environment variables are allowed.', 'Es sind höchstens {count} Umgebungsvariablen erlaubt.', { count: MAX_ENVIRONMENT_VARIABLES })
    : environmentBytes > MAX_ENVIRONMENT_BYTES
      ? t('Environment variables may total at most 256 KiB.', 'Umgebungsvariablen dürfen zusammen höchstens 256 KiB groß sein.')
      : undefined;

  const validationErrors = useMemo(() => {
    const port = Number(config.port);
    const name = config.name.trim();
    const trimmedBranch = branch.trim();
    const healthcheckPath = config.healthcheckPath.trim();
    const firstEnvironmentError = environmentErrors.find((error) => error.key || error.value);
    return {
      repositoryUrl: sourceMode === 'git' && gitSourceMode === 'url' ? repositoryUrlError(repositoryUrl) : undefined,
      githubRepository: sourceMode === 'git' && gitSourceMode === 'github'
        ? !githubSettings.data?.connected
          ? t('Connect a GitHub installation first or use a public HTTPS URL.', 'Verbinde zuerst eine GitHub-Installation oder verwende eine öffentliche HTTPS-URL.')
          : !selectedRepository
            ? t('Select a GitHub repository.', 'Wähle ein GitHub-Repository aus.')
            : undefined
        : undefined,
      branch: sourceMode !== 'git'
        ? undefined
        : !trimmedBranch
          ? t('Enter the branch to deploy.', 'Gib den Branch an, der deployed werden soll.')
          : trimmedBranch.length > MAX_BRANCH_LENGTH
            ? t('The branch may contain at most {count} characters.', 'Der Branch darf höchstens {count} Zeichen lang sein.', { count: MAX_BRANCH_LENGTH })
            : undefined,
      source: sourceMode === 'upload' && !hasUpload
        ? uploadKind === 'zip' ? t('Select a ZIP archive.', 'Wähle ein ZIP-Archiv aus.') : t('Select a project folder.', 'Wähle einen Projektordner aus.')
        : undefined,
      staticBasePath: staticPathSupported && staticBasePath !== null
        ? staticBasePathError(staticBasePath)
        : undefined,
      name: !name
        ? t('Give your project a name.', 'Gib deinem Projekt einen Namen.')
        : name.length < 2
          ? t('The project name must contain at least 2 characters.', 'Der Projektname muss mindestens 2 Zeichen lang sein.')
          : name.length > MAX_PROJECT_NAME_LENGTH
            ? t('The project name may contain at most {count} characters.', 'Der Projektname darf höchstens {count} Zeichen lang sein.', { count: MAX_PROJECT_NAME_LENGTH })
            : undefined,
      environment: firstEnvironmentError?.key ?? firstEnvironmentError?.value ?? environmentGlobalError,
      port: config.port && (!Number.isInteger(port) || port < 1 || port > 65535)
        ? t('The port must be an integer between 1 and 65535.', 'Der Port muss eine ganze Zahl zwischen 1 und 65535 sein.')
        : undefined,
      healthcheckPath: healthcheckPath && !healthcheckPath.startsWith('/')
        ? t('The health-check path must begin with /.', 'Der Healthcheck-Pfad muss mit / beginnen.')
        : healthcheckPath.length > MAX_HEALTHCHECK_PATH_LENGTH
          ? t('The health-check path may contain at most {count} characters.', 'Der Healthcheck-Pfad darf höchstens {count} Zeichen lang sein.', { count: MAX_HEALTHCHECK_PATH_LENGTH })
          : undefined,
      rootDirectory: relativePathError(config.rootDirectory, t('The root directory', 'Das Root-Verzeichnis')),
      dockerfilePath: config.buildType === 'dockerfile'
        ? relativePathError(config.dockerfilePath || 'Dockerfile', t('The Dockerfile path', 'Der Dockerfile-Pfad'))
        : undefined,
    };
  }, [
    branch,
    config.buildType,
    config.dockerfilePath,
    config.healthcheckPath,
    config.name,
    config.port,
    config.rootDirectory,
    environmentErrors,
    environmentGlobalError,
    gitSourceMode,
    githubSettings.data?.connected,
    hasUpload,
    repositoryUrl,
    selectedRepository,
    sourceMode,
    staticBasePath,
    staticPathSupported,
    uploadKind,
    t,
  ]);

  const validationMessages = useMemo(() => Array.from(new Set(
    Object.values(validationErrors).filter((message): message is string => Boolean(message)),
  )), [validationErrors]);

  const sourceReady = sourceMode === 'git'
    ? !validationErrors.repositoryUrl && !validationErrors.githubRepository && !validationErrors.branch
    : !validationErrors.source;
  const buildRoutingReady = !validationErrors.port
    && !validationErrors.healthcheckPath
    && !validationErrors.rootDirectory
    && !validationErrors.dockerfilePath
    && !validationErrors.staticBasePath;
  const incompleteItems = [
    analysisInProgress
      ? t('Finish source analysis', 'Quellanalyse abschließen')
      : undefined,
    !sourceReady
      ? sourceMode === 'git' ? t('Connect repository', 'Repository verbinden') : t('Select project files', 'Projektdateien auswählen')
      : undefined,
    validationErrors.name ? t('Add project name', 'Projektname ergänzen') : undefined,
    validationErrors.environment ? t('Check environment variables', 'Umgebungsvariablen prüfen') : undefined,
    !buildRoutingReady ? t('Check build & routing', 'Build & Routing prüfen') : undefined,
  ].filter((item): item is string => Boolean(item));
  const actionStatus = analysisInProgress
    ? t('Analyzing source', 'Quelle wird analysiert')
    : incompleteItems.length === 0
    ? t('Ready', 'Bereit')
    : incompleteItems.length === 1 ? t('1 item missing', '1 Angabe fehlt') : t('{count} items missing', '{count} Angaben fehlen', { count: incompleteItems.length });
  const buildTypeLabel = {
    auto: fileStorageDetected
      ? t('File storage · detected', 'Dateiablage · erkannt')
      : t('Automatic', 'Automatisch'),
    node: 'Node.js / Next.js',
    static: t('Static site', 'Statische Seite'),
    dockerfile: 'Dockerfile',
  }[config.buildType];
  const reviewOverrides = [
    sourceMode === 'git' && branch.trim() && branch.trim() !== 'main'
      ? { label: 'Branch', value: branch.trim() }
      : undefined,
    sourceMode === 'git'
      ? { label: t('Deployment', 'Bereitstellung'), value: gitSourceMode === 'github' ? autoDeploy ? t('Auto-deploy on push', 'Auto-Deploy bei Push') : t('Manual only', 'Nur manuell') : t('Manual only', 'Nur manuell') }
      : undefined,
    (config.buildType !== 'auto' || fileStorageDetected)
      ? { label: 'Build', value: buildTypeLabel }
      : undefined,
    config.rootDirectory.trim()
      ? { label: t('Root directory', 'Root-Verzeichnis'), value: config.rootDirectory.trim() }
      : undefined,
    config.port && config.port !== initialConfig.port
      ? { label: 'Port', value: config.port }
      : undefined,
    config.healthcheckPath.trim() && config.healthcheckPath.trim() !== initialConfig.healthcheckPath
      ? { label: 'Healthcheck', value: config.healthcheckPath.trim() }
      : undefined,
    config.buildType === 'dockerfile' && config.dockerfilePath.trim() !== initialConfig.dockerfilePath
      ? { label: 'Dockerfile', value: config.dockerfilePath.trim() }
      : undefined,
    staticPathSupported && staticBasePath !== null
      ? { label: t('Hosting path', 'Hosting-Pfad'), value: staticBasePath }
      : undefined,
    environment.length > 0
      ? { label: t('Variables', 'Variablen'), value: String(environment.length) }
      : undefined,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const sourceLabel = sourceMode === 'git'
    ? gitSourceMode === 'github'
      ? selectedRepository?.fullName ?? t('GitHub repository not selected', 'GitHub-Repository noch nicht ausgewählt')
      : repositoryUrl.trim().replace(/^https?:\/\//, '') || t('Repository not entered', 'Repository noch nicht angegeben')
    : zipFile?.name
      ?? folderFiles[0]?.webkitRelativePath.split('/')[0]
      ?? t('No files selected', 'Noch keine Dateien ausgewählt');

  function focusFirstError() {
    let targetId: string | undefined;

    if (validationErrors.githubRepository) targetId = 'github-repository';
    else if (validationErrors.repositoryUrl) targetId = 'repository-url';
    else if (validationErrors.branch) targetId = 'repository-branch';
    else if (validationErrors.source) targetId = uploadKind === 'zip' ? 'zip-upload-trigger' : 'folder-upload-trigger';
    else if (validationErrors.name) targetId = 'project-name';
    else if (validationErrors.rootDirectory) {
      setAdvancedOpen('advanced');
      targetId = 'root-directory';
    } else if (validationErrors.port) {
      setAdvancedOpen('advanced');
      targetId = 'project-port';
    } else if (validationErrors.healthcheckPath) {
      setAdvancedOpen('advanced');
      targetId = 'healthcheck-path';
    } else if (validationErrors.dockerfilePath) {
      setAdvancedOpen('advanced');
      targetId = 'dockerfile-path';
    } else if (validationErrors.staticBasePath) {
      setAdvancedOpen('advanced');
      targetId = 'new-project-static-base-path';
    } else if (validationErrors.environment) {
      setEnvironmentOpen('environment');
      const index = environmentErrors.findIndex((error) => error.key || error.value);
      const variable = environment[index] ?? environment.at(-1);
      const error = environmentErrors[index];
      if (variable) targetId = index === -1 || (error?.value && !error.key)
        ? `environment-value-${variable.id}`
        : `environment-key-${variable.id}`;
    }

    window.setTimeout(() => targetId && document.getElementById(targetId)?.focus(), 0);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitAttempted(true);

    // Wait for the advisory preflight to apply its detected monorepo root and
    // runtime defaults. A failed analysis switches to the non-blocking error
    // state, so users can always continue manually.
    if (analysisInProgress) return;

    if (validationMessages.length > 0) {
      focusFirstError();
      return;
    }

    setSubmitAttempted(false);
    createProject.mutate();
  }

  return (
    <div className="space-y-7 pb-28 xl:pb-0">
      <NavigationGuard
        when={navigationProtected}
        locked={createProject.isPending}
        title={createProject.isPending ? t('Project is still being created', 'Projekt wird noch angelegt') : t('Project has not been created', 'Projekt noch nicht angelegt')}
        description={createProject.isPending
          ? t('Stay on this page until every file is transferred and the first deployment is created.', 'Bitte bleibe auf dieser Seite, bis alle Dateien übertragen und das erste Deployment angelegt wurden.')
          : t('Leaving discards the project data and selected files you entered.', 'Beim Verlassen gehen deine eingegebenen Projektdaten und ausgewählten Dateien verloren.')}
      />

      {createProject.isPending ? (
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled>
          <ArrowLeft aria-hidden="true" /> {t('Back to overview', 'Zur Übersicht')}
        </Button>
      ) : (
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:text-foreground">
          <Link to="/projects"><ArrowLeft aria-hidden="true" /> {t('Back to project list', 'Zur Projektliste')}</Link>
        </Button>
      )}

      <PageIntro
        eyebrow={t('New project', 'Neues Projekt')}
        title={t('Create project', 'Projekt anlegen')}
        description={t('Choose a source, name the project, and start the first build.', 'Quelle auswählen, Projekt benennen und den ersten Build starten.')}
      />

      {createProject.isError && (
        <Alert
          id="create-project-error"
          variant="destructive"
          className="scroll-mt-24 px-3 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          tabIndex={-1}
        >
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t('Project could not be created', 'Projekt konnte nicht angelegt werden')}</AlertTitle>
          <AlertDescription>
            {createProject.error instanceof Error ? createProject.error.message : t('Please try again.', 'Bitte versuche es erneut.')}
          </AlertDescription>
        </Alert>
      )}

      <form
        className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]"
        onSubmit={submit}
        noValidate
        aria-busy={createProject.isPending}
      >
        <div className="min-w-0 divide-y">
          <section className="pb-8" aria-labelledby="source-step-title">
            <div className="mb-5">
              <h2 id="source-step-title" className="text-lg font-semibold">{t('Source', 'Quelle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('Choose a GitHub repository, use a public Git URL, or upload files directly.', 'Wähle ein GitHub-Repository, verwende eine öffentliche Git-URL oder lade Dateien direkt hoch.')}</p>
            </div>

            <Tabs
                value={sourceMode}
                onValueChange={(value) => changeSourceMode(value as SourceMode)}
              >
                <TabsList className="grid w-full grid-cols-2 sm:w-fit">
                  <TabsTrigger
                    value="git"
                    disabled={createProject.isPending}
                    className="min-w-0 gap-1.5 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
                  >
                    <GitBranch className="size-4" aria-hidden="true" /> Git Repository
                  </TabsTrigger>
                  <TabsTrigger
                    value="upload"
                    disabled={createProject.isPending}
                    className="min-w-0 gap-1.5 px-2 text-xs sm:gap-2 sm:px-4 sm:text-sm"
                  >
                    <UploadCloud className="size-4" aria-hidden="true" /> {t('Upload', 'Hochladen')}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="git" className="mt-5 space-y-4">
                  <div className="flex w-full gap-1 rounded-lg bg-muted p-1 sm:w-fit" aria-label={t('Choose Git source', 'Git-Quelle auswählen')}>
                    <Button
                      type="button"
                      size="sm"
                      variant={gitSourceMode === 'github' ? 'secondary' : 'ghost'}
                      className="flex-1 sm:flex-none"
                      onClick={() => {
                        if (gitSourceMode !== 'github') resetGitAnalysis();
                        setGitSourceMode('github');
                      }}
                      disabled={createProject.isPending}
                    >
                      <Github aria-hidden="true" /> GitHub
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={gitSourceMode === 'url' ? 'secondary' : 'ghost'}
                      className="flex-1 sm:flex-none"
                      onClick={() => {
                        if (gitSourceMode !== 'url') resetGitAnalysis();
                        setGitSourceMode('url');
                      }}
                      disabled={createProject.isPending}
                    >
                      <GitBranch aria-hidden="true" /> HTTPS-URL
                    </Button>
                  </div>

                  {gitSourceMode === 'github' ? (
                    githubSettings.isLoading ? (
                      <div className="flex min-h-36 items-center justify-center rounded-xl border bg-muted/15 text-sm text-muted-foreground" role="status">
                        <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> {t('Loading GitHub connection …', 'GitHub-Verbindung wird geladen …')}
                      </div>
                    ) : githubSettings.isError || !githubSettings.data?.connected ? (
                      <Alert variant={githubSettings.isError ? 'destructive' : 'default'}>
                        <Github aria-hidden="true" />
                        <AlertTitle>{githubSettings.isError ? t('GitHub is currently unavailable', 'GitHub ist gerade nicht erreichbar') : t('Connect GitHub first', 'GitHub zuerst verbinden')}</AlertTitle>
                        <AlertDescription className="grid gap-3">
                          <p>{githubSettings.isError
                            ? (githubSettings.error instanceof Error ? githubSettings.error.message : t('Please try again.', 'Bitte versuche es erneut.'))
                            : t('Install the Shelter GitHub App once. You can then select private repositories here as well.', 'Installiere die Shelter GitHub App einmalig. Danach kannst du hier auch private Repositories auswählen.')}</p>
                          <div className="flex flex-wrap gap-2">
                            {githubSettings.isError && <Button type="button" variant="outline" size="sm" onClick={() => githubSettings.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
                            <Button asChild size="sm"><Link to="/settings/github">{t('Set up GitHub', 'GitHub einrichten')} <ArrowRight /></Link></Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setGitSourceMode('url')}>{t('Use public URL', 'Öffentliche URL verwenden')}</Button>
                          </div>
                        </AlertDescription>
                      </Alert>
                    ) : githubRepositories.isLoading ? (
                      <div className="flex min-h-36 items-center justify-center rounded-xl border bg-muted/15 text-sm text-muted-foreground" role="status">
                        <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" /> {t('Loading repositories …', 'Repositories werden geladen …')}
                      </div>
                    ) : githubRepositories.isError ? (
                      <Alert variant="destructive">
                        <TriangleAlert aria-hidden="true" />
                        <AlertTitle>{t('Repositories could not be loaded', 'Repositories konnten nicht geladen werden')}</AlertTitle>
                        <AlertDescription className="grid gap-3">
                          <p>{githubRepositories.error instanceof Error ? githubRepositories.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</p>
                          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => githubRepositories.refetch()}>{t('Reload', 'Erneut laden')}</Button>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <div className="overflow-hidden rounded-xl border bg-card text-card-foreground">
                        <div className="flex items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/30"><Github className="size-4" aria-hidden="true" /></span>
                            <div className="min-w-0">
                              <strong className="block text-sm font-medium">{t('Select repository', 'Repository auswählen')}</strong>
                              <span className="mt-0.5 block text-xs text-muted-foreground">{t('{count} available', '{count} verfügbar', { count: githubRepositories.data?.length ?? 0 })}</span>
                            </div>
                          </div>
                          <Badge variant="outline">GitHub App</Badge>
                        </div>
                        <div className="grid gap-5 p-4 sm:p-5">
                          {(githubRepositories.data?.length ?? 0) === 0 && (
                            <Alert>
                              <Github aria-hidden="true" />
                              <AlertTitle>{t('No repositories shared', 'Keine Repositories freigegeben')}</AlertTitle>
                              <AlertDescription className="grid gap-3">
                                <p>{t('Open the GitHub installation and grant Shelter access to at least one repository.', 'Öffne die GitHub-Installation und gib mindestens ein Repository für Shelter frei.')}</p>
                                <Button asChild variant="outline" size="sm" className="w-fit"><Link to="/settings/github">{t('Manage installation', 'Installation verwalten')} <ArrowRight /></Link></Button>
                              </AlertDescription>
                            </Alert>
                          )}
                          <div className="grid gap-4 md:grid-cols-2">
                            <Field
                              id="github-repository-search"
                              label={t('Search repositories', 'Repositories durchsuchen')}
                              value={repositorySearch}
                              onChange={(event) => setRepositorySearch(event.target.value)}
                              placeholder={t('Organization or repository', 'Organisation oder Repository')}
                              disabled={createProject.isPending}
                            />
                            <SelectField
                              id="github-repository"
                              label="Repository"
                              value={selectedRepositoryKey}
                              onChange={(event) => {
                                const nextKey = event.target.value;
                                const repository = githubRepositories.data?.find((candidate) => (
                                  githubRepositoryKey(candidate.installationId, candidate.id) === nextKey
                                ));
                                resetGitAnalysis();
                                setSelectedRepositoryKey(nextKey);
                                if (repository) {
                                  setBranch(repository.defaultBranch || 'main');
                                  if (!projectNameManuallyEdited.current) updateConfig('name', repository.name.replace(/[-_]+/g, ' '), false);
                                }
                              }}
                              error={submitAttempted ? validationErrors.githubRepository : undefined}
                              disabled={createProject.isPending || filteredRepositories.length === 0}
                            >
                              <option value="">{t('Select repository', 'Repository auswählen')}</option>
                              {filteredRepositories.map((repository) => (
                                <option key={githubRepositoryKey(repository.installationId, repository.id)} value={githubRepositoryKey(repository.installationId, repository.id)}>
                                  {repository.fullName}{repository.private ? ` · ${t('private', 'privat')}` : ''}
                                </option>
                              ))}
                            </SelectField>
                          </div>
                          {repositorySearch.trim() && filteredRepositories.length === 0 && (githubRepositories.data?.length ?? 0) > 0 && (
                            <p className="text-xs text-muted-foreground">{t('No repositories found for “{query}”.', 'Keine Repositories für „{query}“ gefunden.', { query: repositorySearch.trim() })}</p>
                          )}

                          {githubBranches.isError ? (
                            <Field
                              id="repository-branch"
                              label="Branch"
                              value={branch}
                              onChange={(event) => {
                                resetGitAnalysis();
                                setBranch(event.target.value);
                              }}
                              hint={t('Branches could not be loaded; enter the name manually.', 'Branches konnten nicht geladen werden; du kannst den Namen manuell eingeben.')}
                              error={submitAttempted ? validationErrors.branch : undefined}
                              disabled={createProject.isPending}
                            />
                          ) : (
                            <SelectField
                              id="repository-branch"
                              label="Branch"
                              value={branch}
                              onChange={(event) => {
                                resetGitAnalysis();
                                setBranch(event.target.value);
                              }}
                              hint={selectedRepository ? t('Default: {branch}', 'Standard: {branch}', { branch: selectedRepository.defaultBranch }) : t('Select a repository first', 'Wähle zuerst ein Repository')}
                              error={submitAttempted ? validationErrors.branch : undefined}
                              disabled={!selectedRepository || githubBranches.isLoading || createProject.isPending}
                            >
                              {!selectedRepository && <option value="main">{t('Select a repository first', 'Repository zuerst auswählen')}</option>}
                              {selectedRepository && githubBranches.isLoading && <option value={branch}>{t('Loading branches …', 'Branches werden geladen …')}</option>}
                              {githubBranches.data?.map((githubBranch) => (
                                <option key={githubBranch.name} value={githubBranch.name}>{githubBranch.name}{githubBranch.protected ? ` · ${t('protected', 'geschützt')}` : ''}</option>
                              ))}
                            </SelectField>
                          )}

                          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 p-4">
                            <div className="min-w-0">
                              <Label htmlFor="new-project-auto-deploy" className="font-medium">{t('Automatically deploy GitHub pushes', 'Bei GitHub-Push automatisch deployen')}</Label>
                              <p id="new-project-auto-deploy-description" className="mt-1 text-xs leading-5 text-muted-foreground">
                                {autoDeploy
                                  ? <>{t('Every new push to', 'Jeder neue Push auf')} <span className="font-mono text-foreground">{branch || t('the selected branch', 'den gewählten Branch')}</span> {t('starts a deployment.', 'startet ein Deployment.')}</>
                                  : <>{t('Disabled. You can fetch the saved branch manually at any time using “Deploy current source”.', 'Ausgeschaltet. Du kannst den gespeicherten Branch später jederzeit über „Aktuellen Stand deployen“ manuell laden.')}</>}
                              </p>
                            </div>
                            <Switch
                              id="new-project-auto-deploy"
                              checked={autoDeploy}
                              onCheckedChange={setAutoDeploy}
                              disabled={createProject.isPending}
                              aria-label={t('Automatic deployments', 'Automatische Deployments')}
                              aria-describedby="new-project-auto-deploy-description"
                            />
                          </div>

                          {selectedRepository && (
                            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                              <Github className="size-3.5 shrink-0" aria-hidden="true" />
                              <span className="truncate">{selectedRepository.fullName}</span>
                              {selectedRepository.private && <Badge variant="secondary" className="shrink-0">{t('Private', 'Privat')}</Badge>}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  ) : (
                    <>
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(11rem,0.6fr)]">
                        <Field
                          id="repository-url"
                          label="Repository URL"
                          name="repositoryUrl"
                          type="url"
                          value={repositoryUrl}
                          onChange={(event) => {
                            resetDetectedBuildConfig();
                            setRepositoryUrl(event.target.value);
                            if (!projectNameManuallyEdited.current) updateConfig('name', projectNameFromRepository(event.target.value), false);
                          }}
                          placeholder="https://github.com/acme/website.git"
                          hint={t('Public HTTPS repository without credentials', 'Öffentliches HTTPS-Repository ohne Zugangsdaten')}
                          error={submitAttempted ? validationErrors.repositoryUrl : undefined}
                          disabled={createProject.isPending}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                        <Field
                          id="repository-branch"
                          label="Branch"
                          name="branch"
                          value={branch}
                          onChange={(event) => {
                            resetDetectedBuildConfig();
                            setBranch(event.target.value);
                          }}
                          placeholder="main"
                          maxLength={MAX_BRANCH_LENGTH}
                          error={submitAttempted ? validationErrors.branch : undefined}
                          disabled={createProject.isPending}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                      </div>
                      <Alert role="note">
                        <ShieldCheck aria-hidden="true" />
                        <AlertTitle>{t('Manual only', 'Nur manuell')}</AlertTitle>
                        <AlertDescription>{t(
                          'Only public HTTPS repositories are supported. Auto-deploy is unavailable, and framework detection runs securely after Shelter clones the source. Use the GitHub picker above for live detection before creating the project.',
                          'Nur öffentliche HTTPS-Repositories werden unterstützt. Auto-Deploy ist nicht verfügbar; die Framework-Erkennung läuft sicher, nachdem Shelter die Quelle geklont hat. Nutze die GitHub-Auswahl oben für die Live-Erkennung vor dem Anlegen.',
                        )}</AlertDescription>
                      </Alert>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="upload" className="mt-5 space-y-4">
                  <RadioGroup
                    value={uploadKind}
                    onValueChange={(value) => changeUploadKind(value as UploadKind)}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                    aria-label={t('Upload type', 'Upload-Typ')}
                    disabled={createProject.isPending}
                  >
                    <Label
                      htmlFor="upload-kind-zip"
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-[color,background-color,border-color,box-shadow]',
                        'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
                        'has-[button:disabled]:cursor-not-allowed',
                        uploadKind === 'zip'
                          ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
                          : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
                      )}
                    >
                      <RadioGroupItem id="upload-kind-zip" value="zip" className="focus-visible:ring-0" />
                      <FileArchive className="size-4 text-muted-foreground" aria-hidden="true" /> {t('ZIP archive', 'ZIP-Archiv')}
                    </Label>
                    <Label
                      htmlFor="upload-kind-folder"
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-[color,background-color,border-color,box-shadow]',
                        'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
                        'has-[button:disabled]:cursor-not-allowed',
                        uploadKind === 'folder'
                          ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
                          : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
                      )}
                    >
                      <RadioGroupItem id="upload-kind-folder" value="folder" className="focus-visible:ring-0" />
                      <FolderOpen className="size-4 text-muted-foreground" aria-hidden="true" /> {t('Project folder', 'Projektordner')}
                    </Label>
                  </RadioGroup>

                  <input
                    ref={zipInput}
                    className="sr-only"
                    id={zipInputId}
                    type="file"
                    accept=".zip,application/zip"
                    onChange={selectZip}
                    disabled={uploadKind !== 'zip' || createProject.isPending}
                    tabIndex={-1}
                  />
                  <input
                    ref={folderInput}
                    className="sr-only"
                    id={folderInputId}
                    type="file"
                    multiple
                    webkitdirectory=""
                    directory=""
                    onChange={selectFolder}
                    disabled={uploadKind !== 'folder' || createProject.isPending}
                    tabIndex={-1}
                  />

                  {hasUpload ? (
                    <div className="space-y-3">
                      <div className="flex min-w-0 items-center gap-3 rounded-md border p-3.5">
                        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          <Archive className="size-5" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <strong className="block truncate text-sm">
                            {zipFile?.name ?? folderFiles[0]?.webkitRelativePath.split('/')[0] ?? t('Project folder', 'Projektordner')}
                          </strong>
                          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                            {zipFile
                              ? formatBytes(zipFile.size)
                              : t('{count} files · {size} · archived locally', '{count} Dateien · {size} · wird lokal gepackt', { count: folderFiles.length, size: formatBytes(folderSize) })}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={resetFile}
                          disabled={createProject.isPending}
                          aria-label={t('Remove selection', 'Auswahl entfernen')}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <X aria-hidden="true" />
                        </Button>
                      </div>
                      {fileStorageDetected && selectedApplication?.rendering !== 'files' && (
                        <Alert className="border-primary/20 bg-primary/[0.035]">
                          <Files aria-hidden="true" />
                          <AlertTitle>{t('File storage detected', 'Dateiablage erkannt')}</AlertTitle>
                          <AlertDescription>
                            {t(
                              'No app entry point was found. Shelter will publish these files at their original paths without running an application build.',
                              'Es wurde kein App-Einstiegspunkt gefunden. Shelter veröffentlicht die Dateien unter ihren ursprünglichen Pfaden, ohne einen App-Build auszuführen.',
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>
                  ) : (
                    <div className="grid min-h-52 place-items-center rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center sm:px-8">
                      <div className="flex max-w-md flex-col items-center">
                        <span className="mb-3 grid size-11 place-items-center rounded-md border bg-background text-muted-foreground">
                          {uploadKind === 'zip' ? <PackageOpen aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
                        </span>
                        <strong className="text-base">
                          {uploadKind === 'zip' ? t('Select ZIP archive', 'ZIP-Archiv auswählen') : t('Select project folder', 'Projektordner auswählen')}
                        </strong>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                          {uploadKind === 'zip'
                            ? t('Select a ZIP file containing your source code or build.', 'Wähle eine ZIP-Datei mit deinem Quellcode oder Build aus.')
                            : t('The folder is archived locally in your browser before upload.', 'Der Ordner wird vor dem Upload lokal im Browser gepackt.')}
                        </p>
                        <Button
                          id={uploadKind === 'zip' ? 'zip-upload-trigger' : 'folder-upload-trigger'}
                          type="button"
                          variant="outline"
                          size="lg"
                          className="mt-4 min-w-0 max-w-full"
                          onClick={() => (uploadKind === 'zip' ? zipInput.current : folderInput.current)?.click()}
                          aria-controls={uploadKind === 'zip' ? zipInputId : folderInputId}
                        >
                          {uploadKind === 'zip' ? <FileArchive aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
                          <span className="truncate">{uploadKind === 'zip' ? t('Open ZIP file', 'ZIP-Datei öffnen') : t('Open folder', 'Ordner öffnen')}</span>
                        </Button>
                        <span className="mt-3 text-xs text-muted-foreground">{t('Large files are transferred in secure 10 MB chunks.', 'Große Dateien werden in sicheren 10-MB-Blöcken übertragen.')}</span>
                      </div>
                    </div>
                  )}

                  {submitAttempted && validationErrors.source && (
                    <Alert variant="destructive">
                      <TriangleAlert aria-hidden="true" />
                      <AlertTitle>{t('Project files are missing', 'Projektdateien fehlen')}</AlertTitle>
                      <AlertDescription>{validationErrors.source}</AlertDescription>
                    </Alert>
                  )}

                </TabsContent>
            </Tabs>

            <ProjectAnalysisCard
              className="mt-5"
              status={analysisStatus}
              analysis={activeAnalysis}
              selectedApplicationId={selectedApplicationId}
              onSelectApplication={(applicationId) => {
                if (activeAnalysis) {
                  applyDetectedApplication(applicationId, activeAnalysis);
                  setAppliedAnalysisIdentity(activeAnalysisIdentity);
                }
              }}
              onShowAdvanced={showDetectedSettings}
              onRetry={analysisStatus === 'error' ? retrySourceAnalysis : undefined}
              missingEnvironmentKeys={addableDetectedEnvironmentKeys}
              onAddEnvironmentKeys={addableDetectedEnvironmentKeys.length ? addDetectedEnvironmentVariables : undefined}
            />
          </section>

          <section className="py-8" aria-labelledby="project-step-title">
            <div className="mb-5">
              <h2 id="project-step-title" className="text-lg font-semibold">{t('Project', 'Projekt')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('Give the project a clear name for the dashboard and deployments.', 'Gib dem Projekt einen eindeutigen Namen für Dashboard und Deployments.')}</p>
            </div>
            <div className="max-w-2xl">
              <Field
                id="project-name"
                label={t('Project name', 'Projektname')}
                name="name"
                value={config.name}
                onChange={(event) => {
                  projectNameManuallyEdited.current = true;
                  updateConfig('name', event.target.value);
                }}
                placeholder="Acme Website"
                hint={t('Shown in the dashboard and deployment logs', 'Wird im Dashboard und in Deployment-Logs angezeigt')}
                minLength={2}
                maxLength={MAX_PROJECT_NAME_LENGTH}
                error={submitAttempted ? validationErrors.name : undefined}
                disabled={createProject.isPending}
              />
            </div>
          </section>

          <section className="py-8" aria-labelledby="advanced-step-title">
            <Accordion type="single" collapsible value={advancedOpen} onValueChange={setAdvancedOpen}>
              <AccordionItem value="advanced" className="border-0">
                <AccordionTrigger className="py-0 hover:no-underline">
                  <span className="flex min-w-0 flex-1 items-start justify-between gap-2 pr-1 text-left sm:gap-4 sm:pr-3">
                    <span className="min-w-0">
                      <strong id="advanced-step-title" className="block text-base font-semibold">Build &amp; Routing</strong>
                      <small className="mt-1 block font-normal leading-relaxed text-muted-foreground">{t('Optional: customize detection, paths, and runtime details.', 'Optional: Erkennung, Pfade und Laufzeitdetails anpassen.')}</small>
                    </span>
                    <Badge variant="secondary" className="mt-0.5 shrink-0">{buildTypeLabel}</Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pt-6 pb-0">
                  <div className="grid gap-5 md:grid-cols-2">
                    <SelectField
                      label={t('Build type', 'Build-Typ')}
                      name="buildType"
                      value={config.buildType}
                      onChange={(event) => updateConfig('buildType', event.target.value)}
                      hint={t('Automatic detection recognizes apps, static sites, and safe file collections', 'Automatik erkennt Apps, statische Seiten und sichere Dateiablagen')}
                      disabled={createProject.isPending}
                    >
                      <option value="auto">{t('Detect automatically', 'Automatisch erkennen')}</option>
                      <option value="node">Node.js / Next.js</option>
                      <option value="static">{t('Static site', 'Statische Seite')}</option>
                      <option value="dockerfile">{t('Custom Dockerfile', 'Eigenes Dockerfile')}</option>
                    </SelectField>
                    <Field
                      id="root-directory"
                      label={t('Root directory', 'Root-Verzeichnis')}
                      name="rootDirectory"
                      value={config.rootDirectory}
                      onChange={(event) => updateConfig('rootDirectory', event.target.value)}
                      placeholder="apps/web"
                      hint={t('Leave empty for the repository root', 'Leer lassen für das Repository-Root')}
                      maxLength={MAX_RELATIVE_PATH_LENGTH}
                      error={submitAttempted ? validationErrors.rootDirectory : undefined}
                      disabled={createProject.isPending}
                    />
                    <Field
                      id="project-port"
                      label={t('Internal port', 'Interner Port')}
                      name="port"
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="65535"
                      value={config.port}
                      onChange={(event) => updateConfig('port', event.target.value)}
                      hint={t('Port the application listens on inside the container', 'Port, auf dem die App im Container lauscht')}
                      error={submitAttempted ? validationErrors.port : undefined}
                      disabled={createProject.isPending}
                    />
                    <Field
                      id="healthcheck-path"
                      label={t('Health-check path', 'Healthcheck-Pfad')}
                      name="healthcheckPath"
                      value={config.healthcheckPath}
                      onChange={(event) => updateConfig('healthcheckPath', event.target.value)}
                      placeholder="/api/health"
                      hint={t('Shelter checks this path after startup', 'Shelter prüft diesen Pfad nach dem Start')}
                      maxLength={MAX_HEALTHCHECK_PATH_LENGTH}
                      error={submitAttempted ? validationErrors.healthcheckPath : undefined}
                      disabled={createProject.isPending}
                    />
                    {config.buildType === 'dockerfile' && (
                      <Field
                        id="dockerfile-path"
                        label={t('Dockerfile path', 'Dockerfile-Pfad')}
                        name="dockerfilePath"
                        value={config.dockerfilePath}
                        onChange={(event) => updateConfig('dockerfilePath', event.target.value)}
                        placeholder="Dockerfile"
                        hint={t('Relative to the root directory', 'Relativ zum Root-Verzeichnis')}
                        maxLength={MAX_RELATIVE_PATH_LENGTH}
                        error={submitAttempted ? validationErrors.dockerfilePath : undefined}
                        disabled={createProject.isPending}
                      />
                    )}
                  </div>
                  {staticPathSupported && (
                    <div className="mt-6">
                      <StaticBasePathControl
                        id="new-project-static-base-path"
                        value={staticBasePath}
                        onChange={setStaticBasePath}
                        disabled={createProject.isPending}
                      />
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          <section className="pt-8" aria-labelledby="environment-step-title">
            <Accordion type="single" collapsible value={environmentOpen} onValueChange={setEnvironmentOpen}>
              <AccordionItem value="environment" className="border-0">
                <AccordionTrigger className="py-0 hover:no-underline">
                  <span className="flex min-w-0 flex-1 items-start justify-between gap-2 pr-1 text-left sm:gap-4 sm:pr-3">
                    <span className="min-w-0">
                      <strong id="environment-step-title" className="block text-base font-semibold [overflow-wrap:anywhere]">{t('Environment variables', 'Umgebungsvariablen')}</strong>
                      <small className="mt-1 block font-normal leading-relaxed text-muted-foreground">{t('Optionally add them before the first build.', 'Optional vor dem ersten Build hinterlegen.')}</small>
                    </span>
                    <Badge variant="secondary" className="mt-0.5 shrink-0">
                      {environment.length === 0
                        ? t('None set', 'Keine gesetzt')
                        : environment.length === 1 ? t('1 variable', '1 Variable') : t('{count} variables', '{count} Variablen', { count: environment.length })}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pt-6 pb-0">
                  <div className="space-y-4">
                    {environment.length > 0 ? (
                      <div>
                        <div className="divide-y">
                          <AnimatePresence initial={false}>
                            {environment.map((variable, index) => {
                              const entryErrors = environmentErrors[index];
                              const showKeyError = Boolean(entryErrors?.key && (submitAttempted || variable.key));
                              const showValueError = Boolean(entryErrors?.value && (submitAttempted || variable.value));
                              return (
                                <motion.div
                                  layout
                                  key={variable.id}
                                  initial={{ opacity: 0, y: -6 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  exit={{ opacity: 0, y: -6 }}
                                  className="grid min-w-0 gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_2.25rem] sm:items-start"
                                >
                                  <Field
                                    id={`environment-key-${variable.id}`}
                                    label={`Key ${index + 1}`}
                                    name={`environment-key-${variable.id}`}
                                    autoCapitalize="characters"
                                    autoComplete="off"
                                    value={variable.key}
                                    onChange={(event) => updateEnvironmentVariable(variable.id, 'key', event.target.value)}
                                    placeholder="DATABASE_URL"
                                    maxLength={MAX_ENVIRONMENT_KEY_LENGTH}
                                    error={showKeyError ? entryErrors?.key : undefined}
                                    disabled={createProject.isPending}
                                  />
                                  <Field
                                    id={`environment-value-${variable.id}`}
                                    label={t('Value', 'Wert')}
                                    name={`environment-value-${variable.id}`}
                                    type="password"
                                    autoComplete="new-password"
                                    value={variable.value}
                                    onChange={(event) => updateEnvironmentVariable(variable.id, 'value', event.target.value)}
                                    placeholder={t('Enter value (may be empty)', 'Wert eingeben (darf leer sein)')}
                                    hint={t('Not shown again after saving', 'Wird nach dem Speichern nicht wieder angezeigt')}
                                    maxLength={MAX_ENVIRONMENT_VALUE_LENGTH}
                                    error={showValueError ? entryErrors?.value : undefined}
                                    disabled={createProject.isPending}
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="w-full text-muted-foreground hover:text-destructive sm:mt-7 sm:size-9 sm:px-0"
                                    onClick={() => setEnvironment((current) => current.filter((entry) => entry.id !== variable.id))}
                                    disabled={createProject.isPending}
                                    aria-label={t('Remove {variable}', '{variable} entfernen', { variable: variable.key || `Variable ${index + 1}` })}
                                  >
                                    <X aria-hidden="true" /> <span className="sm:sr-only">{t('Remove', 'Entfernen')}</span>
                                  </Button>
                                </motion.div>
                              );
                            })}
                          </AnimatePresence>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={addEnvironmentVariable}
                          disabled={createProject.isPending || environment.length >= MAX_ENVIRONMENT_VARIABLES}
                        >
                          <Plus aria-hidden="true" /> {environment.length >= MAX_ENVIRONMENT_VARIABLES ? t('Maximum 200 variables', 'Maximal 200 Variablen') : t('Add variable', 'Weitere Variable')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addEnvironmentVariable}
                        disabled={createProject.isPending}
                      >
                        <Plus aria-hidden="true" /> {t('Add first variable', 'Erste Variable hinzufügen')}
                      </Button>
                    )}

                    {submitAttempted && environmentGlobalError && (
                      <Alert variant="destructive">
                        <TriangleAlert aria-hidden="true" />
                        <AlertTitle>{t('Check environment variables', 'Umgebungsvariablen prüfen')}</AlertTitle>
                        <AlertDescription>{environmentGlobalError}</AlertDescription>
                      </Alert>
                    )}

                    <Alert role="note">
                      <TriangleAlert aria-hidden="true" />
                      <AlertTitle>{t('Recognize public variables', 'Öffentliche Variablen erkennen')}</AlertTitle>
                      <AlertDescription>
                        {t('Build scripts can read these values. Next.js intentionally embeds', 'Build-Skripte können diese Werte lesen. Next.js bettet')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em]">NEXT_PUBLIC_*</code> {t('in the public client bundle. Never use secrets there.', 'absichtlich in das öffentliche Client-Bundle ein. Verwende dort niemals Secrets.')}
                      </AlertDescription>
                    </Alert>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>
        </div>

        <aside className="hidden min-w-0 xl:sticky xl:top-6 xl:block">
          <Card className="gap-0 py-0 shadow-sm">
            <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b px-4 py-5">
              <div className="min-w-0">
                <CardTitle><h2 className="text-base">{t('Deploy', 'Bereitstellen')}</h2></CardTitle>
                <CardDescription className="mt-1">{t('Review your choices and start the first build.', 'Prüfe die Auswahl und starte den ersten Build.')}</CardDescription>
              </div>
              <Badge variant="outline" className="shrink-0">{actionStatus}</Badge>
            </CardHeader>

            <CardContent className="space-y-5 px-4 py-5">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('Project', 'Projekt')}</span>
                <p className={cn(
                  'break-words text-sm font-semibold leading-relaxed',
                  validationErrors.name && 'text-muted-foreground',
                )}>
                  {config.name.trim() || t('Project name missing', 'Projektname fehlt')}
                </p>
              </div>

              <div className="space-y-3 border-y py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-muted-foreground">{t('Source', 'Quelle')}</span>
                  <Badge variant="secondary">{sourceMode === 'git' ? gitSourceMode === 'github' ? 'GitHub' : 'Git' : uploadKind === 'zip' ? 'ZIP' : t('Folder', 'Ordner')}</Badge>
                </div>
                <p className="break-words text-sm font-medium leading-relaxed">{sourceLabel}</p>
              </div>

              {reviewOverrides.length > 0 && (
                <dl className="space-y-3 text-xs">
                  {reviewOverrides.map((item) => (
                    <div key={item.label} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3">
                      <dt className="text-muted-foreground">{item.label}</dt>
                      <dd className="break-words text-right font-medium">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {incompleteItems.length > 0 && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <strong className="text-sm font-medium">{t('Still needed', 'Noch offen')}</strong>
                  <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
                    {incompleteItems.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
              )}

              {submitAttempted && validationMessages.length > 0 && (
                <Alert variant="destructive" className="px-3 py-3">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>{t('Please review', 'Bitte noch prüfen')}</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-left">
                      {validationMessages.map((message) => <li key={message}>{message}</li>)}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                size="lg"
                loading={createProject.isPending}
                disabled={createProject.isPending || analysisInProgress}
                className="h-11 w-full"
              >
                {fileStorageDetected ? t('Create file storage', 'Dateiablage anlegen') : t('Create project', 'Projekt anlegen')} {!createProject.isPending && <ArrowRight aria-hidden="true" />}
              </Button>
              <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t('If anything is missing, Shelter jumps directly to the relevant field.', 'Wenn noch etwas fehlt, springt Shelter direkt zum betreffenden Feld.')}
              </p>
            </CardContent>
          </Card>
        </aside>

        <div className="fixed right-0 bottom-0 left-0 z-40 border-t bg-background/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:left-64 xl:hidden">
          <div className="mx-auto flex min-h-18 w-full max-w-[88rem] items-center justify-between gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-8">
            <div className="min-w-0" aria-live="polite">
              <strong className="block truncate text-sm font-medium">{actionStatus}</strong>
              <span className="block truncate text-xs text-muted-foreground">{t('Starts the first build immediately', 'Startet direkt den ersten Build')}</span>
            </div>
            <Button
              type="submit"
              size="lg"
              loading={createProject.isPending}
              disabled={createProject.isPending || analysisInProgress}
              className="h-11 shrink-0"
            >
              <span className="sm:hidden">{fileStorageDetected ? t('Create storage', 'Ablage anlegen') : t('Create project', 'Projekt anlegen')}</span>
              <span className="hidden sm:inline">{fileStorageDetected ? t('Create & publish file storage', 'Dateiablage anlegen & veröffentlichen') : t('Create & deploy project', 'Projekt anlegen & deployen')}</span>
              {!createProject.isPending && <ArrowRight aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </form>

      <AnimatePresence>
        {progress && (
          <motion.div
            className="fixed right-4 bottom-28 z-50 w-[calc(100%-2rem)] max-w-md xl:bottom-4"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            role="status"
            aria-live="polite"
          >
            <Card className="gap-0 py-0 shadow-lg">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <strong className="flex items-center gap-2 text-sm">
                      <UploadCloud className="size-4 shrink-0" aria-hidden="true" /> {progress.label}
                    </strong>
                    {progress.detail && <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{progress.detail}</span>}
                  </div>
                  <b className="text-sm tabular-nums">{Math.round(progress.percent)}%</b>
                </div>
                <Progress value={progress.percent} className="h-1.5" />
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
