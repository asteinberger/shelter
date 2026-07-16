import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  Box,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Clock3,
  Copy,
  ExternalLink,
  Globe2,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Rocket,
  Save,
  ShieldAlert,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api/client';
import { NavigationGuard } from '../components/NavigationGuard';
import { ProjectGitHubConnection } from '../components/ProjectGitHubConnection';
import { ProjectPreviewCard } from '../components/ProjectPreviewCard';
import { ProjectObservabilityTab } from '../components/ProjectObservabilityTab';
import { StaticBasePathControl } from '../components/StaticBasePathControl';
import { Button, ErrorState, Field, PageIntro, SelectField, Skeleton, StatusBadge } from '../components/ui';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '../components/ui/alert';
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
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import type { Domain, EnvironmentVariable, Project } from '../types';
import { formatDate, formatDuration, formatRelative } from '../utils/format';
import {
  activeDeploymentStates,
  configuredGitBranch,
  deploymentSourceLabel,
  withQueuedDeployment,
} from '../utils/deployment';
import { staticBasePathError } from '../utils/static-base-path';
import { domainHostname, isValidSubdomain, normalizeSubdomain, type DomainMode } from '../utils/domain';
import {
  isFileStorageProject,
  projectRuntimeKind,
  usesManagedFileStorageRuntime,
} from '../utils/project-runtime';
import { BRAND_NAME } from '../lib/brand';
import { localize, useI18n } from '@/i18n';

type ProjectTab = 'overview' | 'observability' | 'deployments' | 'domains' | 'environment' | 'settings';

type ProjectBuildType = 'auto' | 'dockerfile' | 'node' | 'static';

interface ProjectSettingsDraft {
  name: string;
  repositoryUrl: string;
  repositoryBranch: string;
  rootDirectory: string;
  buildType: ProjectBuildType;
  dockerfilePath: string;
  port: string;
  healthcheckPath: string;
  staticBasePath: string | null;
  memoryLimit: string;
  cpuLimit: string;
}

const projectTabs: ProjectTab[] = ['overview', 'observability', 'deployments', 'domains', 'environment', 'settings'];
const reservedEnvironmentKeys = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);
const MAX_ENVIRONMENT_VARIABLES = 200;
const MAX_ENVIRONMENT_KEY_LENGTH = 100;
const MAX_ENVIRONMENT_VALUE_LENGTH = 65_536;
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const utf8Encoder = new TextEncoder();

function isProjectTab(value: string | null): value is ProjectTab {
  return Boolean(value && projectTabs.includes(value as ProjectTab));
}

function safeUrl(hostname?: string) {
  if (!hostname) return undefined;
  return /^https?:\/\//i.test(hostname) ? hostname : `https://${hostname}`;
}

function displayRepository(url?: string) {
  if (!url) return localize('Direct upload', 'Direkt-Upload');
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function displayBuildType(project: Project) {
  if (projectRuntimeKind(project) === 'files') return localize('File storage', 'Dateiablage');
  if (project.currentDeployment?.runtimeDescription) return project.currentDeployment.runtimeDescription;
  if (project.buildType === 'auto' && project.sourceType === 'upload' && project.currentDeployment?.internalPort === 8080) {
    return localize('Static distribution', 'Statische Distribution');
  }
  const labels: Record<string, string> = {
    auto: localize('Automatic', 'Automatisch'),
    dockerfile: 'Dockerfile',
    node: 'Node.js / Next.js',
    static: localize('Static website', 'Statische Website'),
  };
  return labels[project.buildType ?? ''] ?? project.framework ?? project.buildType ?? localize('Automatic', 'Automatisch');
}

function projectSettingsDraft(project: Project): ProjectSettingsDraft {
  return {
    name: project.name,
    repositoryUrl: project.repositoryUrl ?? '',
    repositoryBranch: project.branch ?? project.repositoryBranch ?? 'main',
    rootDirectory: project.rootDirectory ?? '.',
    buildType: (project.buildType as ProjectBuildType | undefined) ?? 'auto',
    dockerfilePath: project.dockerfilePath ?? 'Dockerfile',
    port: String(project.port ?? 3000),
    healthcheckPath: project.healthcheckPath ?? '/',
    staticBasePath: project.staticBasePath ?? null,
    memoryLimit: project.memoryLimit ?? '1g',
    cpuLimit: project.cpuLimit ?? '1.0',
  };
}

function isRelativeProjectPath(value: string) {
  const normalized = value.replaceAll('\\', '/');
  return Boolean(normalized) && !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

function repositoryUrlError(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return localize('The repository must be reachable over HTTPS.', 'Das Repository muss über HTTPS erreichbar sein.');
    if (url.username || url.password) return localize('Credentials cannot be included in the repository URL.', 'Zugangsdaten dürfen nicht in der Repository-URL stehen.');
    return undefined;
  } catch {
    return localize('Enter a complete HTTPS URL.', 'Gib eine vollständige HTTPS-URL ein.');
  }
}

function memoryLimitError(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?[bkmgBKMG]?$/.test(normalized)) return localize('Example: 512m or 2g.', 'Beispiel: 512m oder 2g.');
  const unit = normalized.at(-1)?.toLowerCase();
  const number = Number(unit && /[bkmg]/.test(unit) ? normalized.slice(0, -1) : normalized);
  const multiplier = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  const bytes = number * multiplier;
  return bytes < 64 * 1024 ** 2 || bytes > 64 * 1024 ** 3
    ? localize('Allowed range: 64 MiB to 64 GiB.', 'Erlaubt sind 64 MiB bis 64 GiB.')
    : undefined;
}

function availabilityMessage(reason?: string, fallback?: string) {
  const messages: Record<string, string> = {
    AVAILABLE: localize('This hostname is available in Cloudflare.', 'Dieser Hostname ist in Cloudflare frei.'),
    INVALID_HOSTNAME: localize('The hostname is invalid.', 'Der Hostname ist ungültig.'),
    ZONE_NOT_FOUND: localize('No active Cloudflare zone was found for this hostname.', 'Für diesen Hostname wurde keine aktive Cloudflare-Zone gefunden.'),
    PANEL_DOMAIN_RESERVED: localize('This hostname is already used by the Shelter panel.', 'Dieser Hostname wird bereits vom Shelter-Panel verwendet.'),
    SHELTER_DOMAIN_ASSIGNED: localize('This hostname is already connected to a Shelter project.', 'Dieser Hostname ist bereits mit einem Shelter-Projekt verbunden.'),
    PORTSMITH_DOMAIN_ASSIGNED: localize('This hostname is already connected to a Shelter project.', 'Dieser Hostname ist bereits mit einem Shelter-Projekt verbunden.'),
    CLOUDFLARE_DNS_RECORD_EXISTS: localize('A DNS record for this hostname already exists in Cloudflare.', 'Für diesen Hostname existiert bereits ein DNS-Eintrag in Cloudflare.'),
    ZONE_MISMATCH: localize('This hostname belongs to another, more specific Cloudflare zone. Select that domain from the list.', 'Dieser Hostname gehört zu einer anderen, spezifischeren Cloudflare-Zone. Wähle diese Domain in der Liste aus.'),
    available: localize('This hostname is available in Cloudflare.', 'Dieser Hostname ist in Cloudflare frei.'),
    dns_record_exists: localize('A DNS record for this hostname already exists in Cloudflare.', 'Für diesen Hostname existiert bereits ein DNS-Eintrag in Cloudflare.'),
    cloudflare_dns_exists: localize('A DNS record for this hostname already exists in Cloudflare.', 'Für diesen Hostname existiert bereits ein DNS-Eintrag in Cloudflare.'),
    local_domain_exists: localize('This hostname is already connected to a Shelter project.', 'Dieser Hostname ist bereits mit einem Shelter-Projekt verbunden.'),
    hostname_in_use: localize('This hostname is already connected to a Shelter project.', 'Dieser Hostname ist bereits mit einem Shelter-Projekt verbunden.'),
    panel_domain: localize('This hostname is already used by the Shelter panel.', 'Dieser Hostname wird bereits vom Shelter-Panel verwendet.'),
    invalid_hostname: localize('The hostname is invalid.', 'Der Hostname ist ungültig.'),
    invalid: localize('The hostname is invalid.', 'Der Hostname ist ungültig.'),
    zone_not_found: localize('No active Cloudflare zone was found for this hostname.', 'Für diesen Hostname wurde keine aktive Cloudflare-Zone gefunden.'),
    zone_inactive: localize('The Cloudflare zone is not active.', 'Die Cloudflare-Zone ist nicht aktiv.'),
    cloudflare_unavailable: localize('Cloudflare could not check availability right now.', 'Cloudflare konnte die Verfügbarkeit gerade nicht prüfen.'),
  };
  return (reason && messages[reason]) || fallback || localize('This hostname is unavailable.', 'Dieser Hostname ist nicht verfügbar.');
}

function unavailabilityTitle(reason?: string) {
  if (reason === 'INVALID_HOSTNAME' || reason === 'invalid_hostname' || reason === 'invalid') {
    return localize('Hostname is invalid', 'Hostname ist ungültig');
  }
  if (reason === 'ZONE_MISMATCH') return localize('Another Cloudflare zone is required', 'Andere Cloudflare-Zone erforderlich');
  if (reason === 'ZONE_NOT_FOUND' || reason === 'zone_not_found' || reason === 'zone_inactive') {
    return localize('Cloudflare zone not found', 'Cloudflare-Zone nicht gefunden');
  }
  return localize('Hostname is already in use', 'Hostname ist bereits belegt');
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <span className="text-sm font-medium text-muted-foreground">{eyebrow}</span>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ProjectPage() {
  const { t, locale } = useI18n();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab: ProjectTab = isProjectTab(requestedTab) ? requestedTab : 'overview';
  const [subdomain, setSubdomain] = useState('');
  const [domainMode, setDomainMode] = useState<DomainMode>('subdomain');
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [debouncedHostname, setDebouncedHostname] = useState('');
  const [debouncedZoneId, setDebouncedZoneId] = useState('');
  const [domainFormOpen, setDomainFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteRequestPending, setDeleteRequestPending] = useState(false);
  const [domainToRemove, setDomainToRemove] = useState<Domain>();
  const [domainToReplace, setDomainToReplace] = useState<Domain>();
  const [environmentRemovalIndex, setEnvironmentRemovalIndex] = useState<number>();
  const [environment, setEnvironment] = useState<EnvironmentVariable[]>([]);
  const [githubSettingsDirty, setGithubSettingsDirty] = useState(false);
  const [settings, setSettings] = useState<ProjectSettingsDraft>({
    name: '',
    repositoryUrl: '',
    repositoryBranch: 'main',
    rootDirectory: '.',
    buildType: 'auto',
    dockerfilePath: 'Dockerfile',
    port: '3000',
    healthcheckPath: '/',
    staticBasePath: null,
    memoryLimit: '1g',
    cpuLimit: '1.0',
  });
  const environmentInitialized = useRef('');
  const settingsInitialized = useRef('');
  const deletionFailureFocused = useRef(false);
  const deleteConfirmationRef = useRef<HTMLInputElement>(null);

  const setActiveTab = useCallback((tab: ProjectTab, replace = false) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'overview') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next, { replace });
    window.requestAnimationFrame(() => {
      const tabRoot = document.getElementById('project-tabs');
      const activeTrigger = tabRoot?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      tabRoot?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      activeTrigger?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      activeTrigger?.focus({ preventScroll: true });
    });
  }, [searchParams, setSearchParams]);

  const projectQuery = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      if (deleteRequestPending) return false;
      const currentProject = query.state.data;
      return currentProject?.status === 'deploying'
        || currentProject?.preview?.status === 'pending'
        || activeDeploymentStates.has(currentProject?.currentDeployment?.status ?? '')
        ? 4_000
        : 20_000;
    },
  });
  const project = projectQuery.data;
  const deletionFailed = project?.status === 'deletion_failed' || project?.deletionStatus === 'failed';
  const deployments = project?.deployments ?? [];
  const latestDeployment = project?.currentDeployment ?? deployments[0];
  const manualDeployBranch = project ? configuredGitBranch(project) : 'main';
  const deploymentActive = project?.status === 'deploying'
    || activeDeploymentStates.has(project?.currentDeployment?.status ?? '');
  const supportsStaticBasePath = Boolean(
    project
    && project.buildType !== 'node'
    && project.buildType !== 'dockerfile',
  );
  const settingsSupportsStaticBasePath = settings.buildType !== 'node' && settings.buildType !== 'dockerfile';
  const fileStorage = Boolean(project && isFileStorageProject(project));
  const managedFileStorageRuntime = project
    ? usesManagedFileStorageRuntime(project, settings.buildType)
    : false;
  const settingsStaticBasePathError = settingsSupportsStaticBasePath && settings.staticBasePath !== null
    ? staticBasePathError(settings.staticBasePath)
    : undefined;
  const zonesQuery = useQuery({
    queryKey: ['cloudflare-zones'],
    queryFn: ({ signal }) => api.cloudflareZones(signal),
    enabled: activeTab === 'domains',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const zones = zonesQuery.data ?? [];
  const selectedZone = zones.find((zone) => zone.id === selectedZoneId);
  const normalizedSubdomain = normalizeSubdomain(subdomain);
  const subdomainValid = isValidSubdomain(normalizedSubdomain);
  const candidateHostname = domainHostname(domainMode, selectedZone?.name, normalizedSubdomain);

  const availabilityQuery = useQuery({
    queryKey: ['cloudflare-hostname-availability', debouncedHostname, debouncedZoneId],
    queryFn: ({ signal }) => api.checkCloudflareHostname(debouncedHostname, debouncedZoneId, signal),
    enabled: Boolean(debouncedHostname && debouncedZoneId),
    retry: false,
    staleTime: 10_000,
  });

  useEffect(() => {
    document.title = project ? `${project.name} · ${BRAND_NAME}` : `${t('Project', 'Projekt')} · ${BRAND_NAME}`;
  }, [project, t]);

  useEffect(() => {
    if (!project?.id) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('#project-tabs [role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, project?.id]);

  useEffect(() => {
    if (!project) return;
    if (settingsInitialized.current === project.id) return;
    settingsInitialized.current = project.id;
    setSettings(projectSettingsDraft(project));
  }, [project]);

  useEffect(() => {
    const keys = project?.environmentKeys ?? [];
    const signature = `${project?.id}:${keys.join('|')}`;
    if (project && environmentInitialized.current !== signature) {
      environmentInitialized.current = signature;
      setEnvironment(keys.map((key) => ({ key, value: undefined })));
    }
  }, [project]);

  useEffect(() => {
    if (deletionFailed && !deletionFailureFocused.current) {
      deletionFailureFocused.current = true;
      setActiveTab('settings', true);
    }
  }, [deletionFailed, setActiveTab]);

  useEffect(() => {
    if (zones.length === 0) {
      setSelectedZoneId('');
      return;
    }
    if (!zones.some((zone) => zone.id === selectedZoneId)) setSelectedZoneId(zones[0]?.id ?? '');
  }, [selectedZoneId, zones]);

  useEffect(() => {
    setDebouncedHostname('');
    setDebouncedZoneId('');
    if (activeTab !== 'domains' || !candidateHostname) return undefined;
    const timer = window.setTimeout(() => {
      setDebouncedHostname(candidateHostname);
      setDebouncedZoneId(selectedZoneId);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeTab, candidateHostname, selectedZoneId]);

  const invalidateProject = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['project', id] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['overview'] });
  }, [id, queryClient]);

  const deploy = useMutation({
    mutationFn: (staticBasePath?: string | null) => api.deployProject(id, staticBasePath),
    onSuccess: (queued) => {
      queryClient.setQueryData(['deployment', queued.id], queued);
      queryClient.setQueryData<Project | undefined>(['project', id], (current) => (
        current ? withQueuedDeployment(current, queued) : current
      ));
      invalidateProject();
      toast.success(t('Deployment queued', 'Deployment eingereiht'), {
        description: project?.sourceType === 'git'
          ? t('The current state of “{branch}” is fetched fresh from the repository.', 'Der aktuelle Stand von „{branch}“ wird frisch aus dem Repository geladen.', { branch: manualDeployBranch })
          : t('The build starts as soon as the worker is available.', 'Der Build startet, sobald der Worker frei ist.'),
      });
      navigate(`/projects/${id}/deployments/${queued.id}`);
    },
    onError: (error) => toast.error(t('Deployment could not be started', 'Deployment konnte nicht gestartet werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });
  const addDomain = useMutation({
    mutationFn: async (next: { hostname: string; zoneId: string; replaceDomainId?: string }) => {
      const domain = await api.addDomain(id, next.hostname, next.zoneId);
      if (next.replaceDomainId) {
        try {
          await api.removeDomain(id, next.replaceDomainId);
        } catch (error) {
          throw new Error(t(
            'The new domain {domain} is active, but the previous domain could not be removed: {error}',
            'Die neue Domain {domain} ist aktiv, aber die bisherige Domain konnte nicht entfernt werden: {error}',
            { domain: domain.hostname, error: error instanceof Error ? error.message : t('Unknown error', 'Unbekannter Fehler') },
          ));
        }
      }
      return domain;
    },
    onSuccess: (domain) => {
      setSubdomain('');
      setDomainMode('subdomain');
      setDebouncedHostname('');
      setDebouncedZoneId('');
      setDomainFormOpen(false);
      setDomainToReplace(undefined);
      queryClient.removeQueries({ queryKey: ['cloudflare-hostname-availability'] });
      invalidateProject();
      toast.success(t('Domain connected', 'Domain verbunden'), { description: domain.hostname });
    },
    onError: () => {
      invalidateProject();
      queryClient.invalidateQueries({ queryKey: ['cloudflare-hostname-availability'] });
    },
  });
  const removeDomain = useMutation({
    mutationFn: (domainId: string) => api.removeDomain(id, domainId),
    onSuccess: () => {
      setDomainToRemove(undefined);
      toast.success(t('Domain removed', 'Domain entfernt'));
    },
    onSettled: () => {
      invalidateProject();
      queryClient.invalidateQueries({ queryKey: ['cloudflare-hostname-availability'] });
    },
  });
  const deleteProject = useMutation({
    mutationFn: (confirmation: string) => api.deleteProject(id, confirmation),
    onMutate: async () => {
      setDeleteRequestPending(true);
      await queryClient.cancelQueries({ queryKey: ['project', id] });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['project', id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(t('Project cleanup started', 'Projekt-Cleanup gestartet'));
      navigate('/projects', { replace: true });
    },
    onError: invalidateProject,
    onSettled: () => setDeleteRequestPending(false),
  });
  const saveEnvironment = useMutation({
    mutationFn: () => api.updateEnvironment(
      id,
      environment
        .map(({ key, value }) => ({ key: key.trim(), value: value === '' ? undefined : value }))
        .filter(({ key }) => Boolean(key)),
    ),
    onSuccess: () => {
      invalidateProject();
      setEnvironment((current) => current.map((variable) => ({ key: variable.key, value: undefined })));
      toast.success(t('Environment saved', 'Umgebung gespeichert'), {
        description: fileStorage
          ? t('The values stay stored, but are not injected into the active file storage.', 'Die Werte bleiben gespeichert, werden aber nicht in die aktive Dateiablage injiziert.')
          : t('A new deployment applies the values.', 'Ein neuer Deploy übernimmt die Werte.'),
      });
    },
  });
  const saveSettings = useMutation({
    mutationFn: () => api.updateProject(id, {
      name: settings.name.trim(),
      repositoryUrl: project?.sourceType === 'git' && !project.github ? settings.repositoryUrl.trim() : undefined,
      repositoryBranch: project?.sourceType === 'git' && !project.github ? settings.repositoryBranch.trim() : undefined,
      rootDirectory: settings.rootDirectory.trim(),
      buildType: settings.buildType,
      dockerfilePath: settings.dockerfilePath.trim(),
      port: managedFileStorageRuntime ? undefined : Number(settings.port),
      healthcheckPath: managedFileStorageRuntime ? undefined : settings.healthcheckPath.trim(),
      staticBasePath: settingsSupportsStaticBasePath ? settings.staticBasePath : null,
      memoryLimit: settings.memoryLimit.trim(),
      cpuLimit: settings.cpuLimit.trim(),
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['project', id], updated);
      settingsInitialized.current = updated.id;
      setSettings(projectSettingsDraft(updated));
      invalidateProject();
      toast.success(t('Project saved', 'Projekt gespeichert'), { description: t('Build changes apply to the next deployment.', 'Build-Änderungen gelten beim nächsten Deployment.') });
    },
    onError: (error) => toast.error(t('Project could not be saved', 'Projekt konnte nicht gespeichert werden'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  const primaryUrl = project?.url ?? safeUrl(project?.domains?.find((domain) => domain.status === 'active')?.hostname ?? project?.domains?.[0]?.hostname);
  const environmentErrors = useMemo(() => {
    const knownKeys = new Set(project?.environmentKeys ?? []);
    const keys = environment.map((variable) => variable.key.trim());
    return environment.map((variable, index) => {
      const key = variable.key.trim();
      if (!key) return t('The variable name is missing.', 'Der Variablenname fehlt.');
      if (key.length > MAX_ENVIRONMENT_KEY_LENGTH) return t('The variable name may contain at most {count} characters.', 'Der Variablenname darf höchstens {count} Zeichen lang sein.', { count: MAX_ENVIRONMENT_KEY_LENGTH });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return t('Begin with a letter or underscore; A–Z, 0–9, and _ are allowed.', 'Beginne mit Buchstabe oder Unterstrich; erlaubt sind A–Z, 0–9 und _.');
      if (reservedEnvironmentKeys.has(key)) return t('{key} is managed by Shelter.', '{key} wird von Shelter verwaltet.', { key });
      if (keys.indexOf(key) !== index) return t('This variable name occurs more than once.', 'Dieser Variablenname ist doppelt vorhanden.');
      if ((variable.value?.length ?? 0) > MAX_ENVIRONMENT_VALUE_LENGTH) return t('The value may contain at most {count} characters.', 'Der Wert darf höchstens {count} Zeichen lang sein.', { count: MAX_ENVIRONMENT_VALUE_LENGTH.toLocaleString(locale === 'de' ? 'de-DE' : 'en-US') });
      if (!knownKeys.has(key) && variable.value === undefined) return t('A value is required for a new variable.', 'Für eine neue Variable ist ein Wert erforderlich.');
      if (!knownKeys.has(key) && variable.value === '') return t('A value is required for a new variable.', 'Für eine neue Variable ist ein Wert erforderlich.');
      return undefined;
    });
  }, [environment, locale, project?.environmentKeys, t]);
  const environmentKnownBytes = useMemo(() => environment.reduce((total, variable) => (
    total
    + utf8Encoder.encode(variable.key).byteLength
    + utf8Encoder.encode(variable.value ?? '').byteLength
    + 2
  ), 0), [environment]);
  const environmentGlobalError = environment.length > MAX_ENVIRONMENT_VARIABLES
    ? t('At most {count} variables are allowed.', 'Es sind höchstens {count} Variablen erlaubt.', { count: MAX_ENVIRONMENT_VARIABLES })
    : environmentKnownBytes > MAX_ENVIRONMENT_BYTES
      ? t('The entered variables may total at most 256 KiB.', 'Die eingegebenen Variablen dürfen zusammen höchstens 256 KiB groß sein.')
      : undefined;
  const environmentValid = environmentErrors.every((error) => !error) && !environmentGlobalError;
  const environmentDirty = useMemo(() => {
    const original = project?.environmentKeys ?? [];
    if (environment.length !== original.length) return true;
    return environment.some((variable, index) => variable.key !== original[index] || variable.value !== undefined);
  }, [environment, project?.environmentKeys]);
  const settingsErrors = useMemo(() => {
    const port = Number(settings.port);
    return {
      name: settings.name.trim().length < 2 || settings.name.trim().length > 80
        ? t('The project name must contain between 2 and 80 characters.', 'Der Projektname muss zwischen 2 und 80 Zeichen lang sein.')
        : undefined,
      repositoryUrl: project?.sourceType === 'git' && !project.github ? repositoryUrlError(settings.repositoryUrl.trim()) : undefined,
      repositoryBranch: project?.sourceType === 'git' && !project.github && (!settings.repositoryBranch.trim() || settings.repositoryBranch.trim().length > 160)
        ? t('The branch must contain between 1 and 160 characters.', 'Der Branch muss zwischen 1 und 160 Zeichen lang sein.')
        : undefined,
      rootDirectory: !isRelativeProjectPath(settings.rootDirectory.trim())
        ? t("Use a relative path without '..'.", "Verwende einen relativen Pfad ohne '..'.")
        : undefined,
      dockerfilePath: !isRelativeProjectPath(settings.dockerfilePath.trim())
        ? t("Use a relative path without '..'.", "Verwende einen relativen Pfad ohne '..'.")
        : undefined,
      port: !managedFileStorageRuntime && (!Number.isInteger(port) || port < 1 || port > 65_535)
        ? t('The port must be an integer between 1 and 65535.', 'Der Port muss eine ganze Zahl zwischen 1 und 65535 sein.')
        : undefined,
      healthcheckPath: !managedFileStorageRuntime && (!settings.healthcheckPath.trim().startsWith('/') || settings.healthcheckPath.trim().length > 200)
        ? t("The health-check path must begin with '/' and contain at most 200 characters.", "Der Healthcheck-Pfad muss mit '/' beginnen und höchstens 200 Zeichen lang sein.")
        : undefined,
      staticBasePath: settingsStaticBasePathError,
      memoryLimit: memoryLimitError(settings.memoryLimit),
      cpuLimit: !/^\d+(?:\.\d+)?$/.test(settings.cpuLimit.trim()) || Number(settings.cpuLimit) < 0.1 || Number(settings.cpuLimit) > 64
        ? t('Allowed range: 0.1 to 64 CPUs.', 'Erlaubt sind 0.1 bis 64 CPUs.')
        : undefined,
    };
  }, [managedFileStorageRuntime, project?.github, project?.sourceType, settings, settingsStaticBasePathError, t]);
  const settingsValid = Object.values(settingsErrors).every((error) => !error);
  const settingsDirty = project ? (
    settings.name !== project.name
    || (project.sourceType === 'git' && !project.github && settings.repositoryUrl !== (project.repositoryUrl ?? ''))
    || (project.sourceType === 'git' && !project.github && settings.repositoryBranch !== (project.branch ?? project.repositoryBranch ?? 'main'))
    || settings.rootDirectory !== (project.rootDirectory ?? '.')
    || settings.buildType !== (project.buildType ?? 'auto')
    || settings.dockerfilePath !== (project.dockerfilePath ?? 'Dockerfile')
    || (!managedFileStorageRuntime && settings.port !== String(project.port ?? 3000))
    || (!managedFileStorageRuntime && settings.healthcheckPath !== (project.healthcheckPath ?? '/'))
    || (settingsSupportsStaticBasePath ? settings.staticBasePath : null) !== (project.staticBasePath ?? null)
    || settings.memoryLimit !== (project.memoryLimit ?? '1g')
    || settings.cpuLimit !== (project.cpuLimit ?? '1.0')
  ) : false;

  useEffect(() => {
    if (!environmentDirty && !settingsDirty && !githubSettingsDirty) return undefined;
    const preventNavigation = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventNavigation);
    return () => window.removeEventListener('beforeunload', preventNavigation);
  }, [environmentDirty, githubSettingsDirty, settingsDirty]);

  const checkedAvailability = (
    debouncedHostname === candidateHostname
    && debouncedZoneId === selectedZoneId
    && (availabilityQuery.data?.hostname === candidateHostname || availabilityQuery.data?.hostname === null)
  )
    ? availabilityQuery.data
    : undefined;
  const availabilityPending = Boolean(
    candidateHostname
    && (debouncedHostname !== candidateHostname || debouncedZoneId !== selectedZoneId || availabilityQuery.isFetching),
  );
  const canConnectDomain = Boolean(
    candidateHostname
    && checkedAvailability?.availability
    && checkedAvailability.zone?.id === selectedZoneId
    && !deletionFailed
    && !availabilityPending
    && !addDomain.isPending,
  );

  async function copyUrl() {
    if (!primaryUrl) return;
    try {
      await navigator.clipboard.writeText(primaryUrl);
      toast.success(t('URL copied', 'URL kopiert'), { description: primaryUrl.replace(/^https?:\/\//, '') });
    } catch {
      toast.error(t('URL could not be copied', 'URL konnte nicht kopiert werden'));
    }
  }

  function submitDomain(event: FormEvent) {
    event.preventDefault();
    const checkedHostname = availabilityQuery.data?.hostname;
    if (
      candidateHostname
      && checkedHostname === candidateHostname
      && checkedAvailability?.zone?.id === selectedZoneId
      && availabilityQuery.data?.availability
    ) addDomain.mutate({ hostname: candidateHostname, zoneId: selectedZoneId, replaceDomainId: domainToReplace?.id });
  }

  function updateSubdomain(value: string) {
    let nextValue = value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
    if (selectedZone) {
      const suffix = `.${selectedZone.name}`;
      if (nextValue.endsWith(suffix)) nextValue = nextValue.slice(0, -suffix.length);
    }
    if (addDomain.isError) addDomain.reset();
    setSubdomain(nextValue);
  }

  function requestEnvironmentRemoval(index: number) {
    const variable = environment[index];
    if (!variable) return;
    if (project?.environmentKeys?.includes(variable.key)) setEnvironmentRemovalIndex(index);
    else setEnvironment((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function beginDomainReplacement(domain: Domain) {
    const zone = [...zones]
      .sort((left, right) => right.name.length - left.name.length)
      .find((candidate) => domain.hostname === candidate.name || domain.hostname.endsWith(`.${candidate.name}`));
    setDomainToReplace(domain);
    setDomainFormOpen(true);
    addDomain.reset();
    if (zone) {
      setSelectedZoneId(zone.id);
      const replacingApex = domain.hostname === zone.name;
      setDomainMode(replacingApex ? 'apex' : 'subdomain');
      setSubdomain(replacingApex ? '' : domain.hostname.slice(0, -(zone.name.length + 1)));
    } else {
      setDomainMode('subdomain');
      setSubdomain('');
    }
  }

  if (projectQuery.isLoading) {
    return (
      <div className="grid gap-6" role="status" aria-label={t('Loading project details', 'Projektdetails werden geladen')}>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-12" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (projectQuery.isError || !project) {
    return (
      <div className="grid gap-6">
        <Button asChild variant="ghost" className="w-fit">
          <Link to="/projects"><ArrowLeft /> {t('Back to project list', 'Zur Projektliste')}</Link>
        </Button>
        <ErrorState
          title={t('Project not found', 'Projekt nicht gefunden')}
          message={projectQuery.error instanceof Error ? projectQuery.error.message : t('This project is unavailable.', 'Dieses Projekt ist nicht verfügbar.')}
          action={<Button onClick={() => projectQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  const tabs: Array<{ id: ProjectTab; label: string; count?: number }> = [
    { id: 'overview', label: t('Overview', 'Übersicht') },
    { id: 'observability', label: 'Observability' },
    { id: 'deployments', label: fileStorage ? t('Versions', 'Versionen') : 'Deployments', count: deployments.length },
    { id: 'domains', label: 'Domains', count: project.domains?.length ?? 0 },
    { id: 'environment', label: t('Environment', 'Umgebung'), count: project.environmentKeys?.length ?? 0 },
    { id: 'settings', label: t('Settings', 'Einstellungen') },
  ];
  return (
    <div className="grid min-w-0 gap-6 sm:gap-7">
      <NavigationGuard
        when={environmentDirty || settingsDirty || githubSettingsDirty}
        title={t('Unsaved changes', 'Ungespeicherte Änderungen')}
        description={[environmentDirty, settingsDirty, githubSettingsDirty].filter(Boolean).length > 1
          ? t('Leaving now will discard your unsaved changes to this project.', 'Beim Verlassen gehen deine noch nicht gespeicherten Änderungen an diesem Projekt verloren.')
          : environmentDirty
            ? t('Leaving now will discard your unsaved environment variables.', 'Beim Verlassen gehen deine noch nicht gespeicherten Umgebungsvariablen verloren.')
            : githubSettingsDirty
              ? t('Leaving now will discard your changes to the GitHub branch or auto-deploy setting.', 'Beim Verlassen gehen deine Änderungen an GitHub-Branch oder Auto-Deploy verloren.')
              : t('Leaving now will discard your unsaved project configuration.', 'Beim Verlassen geht deine noch nicht gespeicherte Projektkonfiguration verloren.')}
      />

      <Button asChild variant="ghost" className="-ml-2 w-fit text-muted-foreground">
        <Link to="/projects"><ArrowLeft /> {t('All projects', 'Alle Projekte')}</Link>
      </Button>

      <PageIntro
        eyebrow={<StatusBadge status={project.status} />}
        title={project.name}
        description={project.sourceType === 'git' ? (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{project.github?.fullName ?? displayRepository(project.repositoryUrl)}</span>
            <span aria-hidden="true">·</span>
            <span>{t('Branch', 'Branch')} <code className="font-mono text-foreground">{manualDeployBranch}</code></span>
            <span aria-hidden="true">·</span>
            <span>{project.github
              ? t(`Auto-deploy ${project.github.autoDeploy ? 'on' : 'off'}`, `Auto-Deploy ${project.github.autoDeploy ? 'an' : 'aus'}`)
              : t('Manual only', 'Nur manuell')}</span>
          </span>
        ) : fileStorage
          ? t('Uploaded file storage · original paths are preserved', 'Hochgeladene Dateiablage · ursprüngliche Pfade bleiben erhalten')
          : t('Directly uploaded project', 'Direkt hochgeladenes Projekt')}
        actions={
          <>
            {primaryUrl && !deletionFailed && (
              <Button asChild variant="outline">
                <a href={primaryUrl} target="_blank" rel="noreferrer">{fileStorage ? t('Open storage', 'Ablage öffnen') : t('Open website', 'Website öffnen')} <ExternalLink /></a>
              </Button>
            )}
            {project.sourceType === 'upload' ? (
              deletionFailed ? (
                <Button disabled><UploadCloud /> {t('Upload new version', 'Neue Version hochladen')}</Button>
              ) : (
                <Button asChild><Link to={`/projects/${project.id}/upload`}><UploadCloud /> {t('Upload new version', 'Neue Version hochladen')}</Link></Button>
              )
            ) : project.sourceType === 'git' ? (
              <Button
                onClick={() => deploy.mutate(undefined)}
                loading={deploy.isPending}
                disabled={deploymentActive || deletionFailed}
                aria-label={t(`Deploy the latest state of branch ${manualDeployBranch}`, `Aktuellen Stand von Branch ${manualDeployBranch} deployen`)}
                title={t(`Fetches the latest commit from “${manualDeployBranch}” and starts a deployment`, `Lädt den neuesten Commit von „${manualDeployBranch}“ und startet ein Deployment`)}
              >
                {!deploy.isPending && <Rocket />} {t('Deploy latest', 'Aktuellen Stand deployen')}
              </Button>
            ) : null}
          </>
        }
      />

      {project.sourceType === 'git' && deploy.isError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t(`Could not deploy “${manualDeployBranch}”`, `„${manualDeployBranch}“ konnte nicht deployed werden`)}</AlertTitle>
          <AlertDescription>{deploy.error instanceof Error ? deploy.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="col-start-2 mt-2 w-fit"
            onClick={() => deploy.mutate(undefined)}
            loading={deploy.isPending}
            disabled={deploymentActive || deletionFailed}
          >
            {!deploy.isPending && <Rocket />} {t('Try again', 'Erneut versuchen')}
          </Button>
        </Alert>
      )}

      {deletionFailed && (
        <Alert variant="destructive" className="p-4">
          <AlertTriangle />
          <AlertTitle>{t('The last deletion attempt was stopped safely.', 'Der letzte Löschversuch wurde sicher angehalten.')}</AlertTitle>
          <AlertDescription>
            {project.deletionError ?? t(
              'At least one project resource could not be cleaned up completely. The project remains disconnected from public routing.',
              'Mindestens eine Projektressource konnte nicht vollständig bereinigt werden. Das Projekt bleibt vom öffentlichen Routing getrennt.',
            )}
          </AlertDescription>
          <Button variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={() => setActiveTab('settings')}>
            {t('Retry cleanup', 'Cleanup erneut versuchen')}
          </Button>
        </Alert>
      )}

      <Tabs id="project-tabs" value={activeTab} onValueChange={(value) => setActiveTab(value as ProjectTab)} className="min-w-0 scroll-mt-20 gap-6">
        <div className="tab-scrollbar -mx-4 max-w-[calc(100%+2rem)] overflow-x-auto overflow-y-hidden px-4 sm:-mx-6 sm:max-w-[calc(100%+3rem)] sm:px-6 lg:mx-0 lg:max-w-full lg:px-0">
          <TabsList variant="line" className="!h-11 min-w-max justify-start gap-2 border-b px-0">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="h-10 min-w-fit px-3 text-sm after:!bottom-0">
                {tab.label}
                {tab.count !== undefined && (
                  <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-[0.65rem]">{tab.count}</Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="grid min-w-0 gap-5">
          <motion.div className="grid min-w-0 gap-5" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            {!deletionFailed && latestDeployment?.status === 'failed' ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>{t('The latest deployment failed', 'Das letzte Deployment ist fehlgeschlagen')}</AlertTitle>
                <AlertDescription>{latestDeployment.error ?? t('Open the build output to investigate the cause.', 'Öffne die Build-Ausgabe, um die Ursache zu prüfen.')}</AlertDescription>
                <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit">
                  <Link to={`/projects/${project.id}/deployments/${latestDeployment.id}`}>{t('Open errors and logs', 'Fehler und Logs öffnen')}</Link>
                </Button>
              </Alert>
            ) : !deletionFailed && latestDeployment && activeDeploymentStates.has(latestDeployment.status) ? (
              <Alert role="status">
                <LoaderCircle className="animate-spin" />
                <AlertTitle>{t('Deployment in progress', 'Deployment läuft')}</AlertTitle>
                <AlertDescription>{t('The current production version stays online until the new build is ready.', 'Die aktuelle Produktionsversion bleibt online, bis der neue Build bereit ist.')}</AlertDescription>
                <Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit">
                  <Link to={`/projects/${project.id}/deployments/${latestDeployment.id}`}>{t('Follow live output', 'Live-Ausgabe verfolgen')}</Link>
                </Button>
              </Alert>
            ) : !deletionFailed && !latestDeployment ? (
              <Alert>
                <Rocket />
                <AlertTitle>{t('Your first deployment is still missing', 'Das erste Deployment fehlt noch')}</AlertTitle>
                <AlertDescription>{t('Start a build before routing traffic to this project.', 'Starte einen Build, bevor du Traffic auf dieses Projekt leitest.')}</AlertDescription>
                {project.sourceType === 'upload' ? (
                  <Button asChild size="sm" className="col-start-2 mt-2 w-fit"><Link to={`/projects/${project.id}/upload`}>{t('Upload version', 'Version hochladen')}</Link></Button>
                ) : (
                  <Button size="sm" className="col-start-2 mt-2 w-fit" onClick={() => deploy.mutate(undefined)} loading={deploy.isPending} disabled={deploymentActive}>
                    {!deploy.isPending && <Rocket />} {t('Deploy latest', 'Aktuellen Stand deployen')}
                  </Button>
                )}
              </Alert>
            ) : !deletionFailed && !primaryUrl ? (
              <Alert>
                <Globe2 />
                <AlertTitle>{t('Not publicly available yet', 'Noch nicht öffentlich erreichbar')}</AlertTitle>
                <AlertDescription>{t('The project is ready. Connect a domain from your Cloudflare account.', 'Das Projekt ist bereit. Verbinde jetzt eine Domain aus deinem Cloudflare-Account.')}</AlertDescription>
                <Button variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={() => setActiveTab('domains')}><Plus /> {t('Connect domain', 'Domain verbinden')}</Button>
              </Alert>
            ) : null}

            <div className={`grid min-w-0 gap-5 ${project.activeDeploymentId && !deletionFailed ? '2xl:grid-cols-[minmax(0,1.65fr)_minmax(21rem,0.7fr)] 2xl:items-start' : ''}`}>
              <aside className={`grid min-w-0 gap-5 ${project.activeDeploymentId && !deletionFailed ? '2xl:sticky 2xl:top-6 2xl:col-start-2 2xl:row-start-1' : 'xl:grid-cols-3'}`} aria-label={t('Production status and project information', 'Produktionsstatus und Projektinformationen')}>
                <Card className="min-w-0">
                  <CardHeader className="border-b">
                    <CardTitle>{t('Production', 'Produktion')}</CardTitle>
                    <CardDescription>{deletionFailed
                      ? t('Public routing paused', 'Öffentliches Routing pausiert')
                      : primaryUrl
                        ? t('Current public address', 'Aktuelle öffentliche Adresse')
                        : t('No domain connected yet', 'Noch keine Domain verbunden')}</CardDescription>
                    <CardAction><StatusBadge status={project.status} /></CardAction>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    {deletionFailed ? (
                      <div className="flex items-start gap-3 text-sm text-muted-foreground">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                        <p>{t('No public traffic until the safe cleanup has completed.', 'Kein öffentlicher Traffic, bis der sichere Cleanup abgeschlossen ist.')}</p>
                      </div>
                    ) : primaryUrl ? (
                      <div className="grid min-w-0 gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/40"><Globe2 className="size-4 text-muted-foreground" /></span>
                          <div className="min-w-0">
                            <span className="block text-xs text-muted-foreground">{t('Public URL', 'Öffentliche URL')}</span>
                            <a className="block truncate font-mono text-sm font-semibold hover:underline" href={primaryUrl} target="_blank" rel="noreferrer">
                              {primaryUrl.replace(/^https?:\/\//, '')}
                            </a>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <Button variant="outline" size="sm" onClick={copyUrl}><Copy /> {t('Copy', 'Kopieren')}</Button>
                          <Button asChild size="sm"><a href={primaryUrl} target="_blank" rel="noreferrer">{t('Open', 'Öffnen')} <ExternalLink /></a></Button>
                        </div>
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <p className="text-sm text-muted-foreground">{t('A Cloudflare route makes this project publicly available.', 'Eine Cloudflare-Route macht dieses Projekt öffentlich erreichbar.')}</p>
                        <Button variant="outline" size="sm" className="w-fit" onClick={() => setActiveTab('domains')}><Plus /> {t('Connect domain', 'Domain verbinden')}</Button>
                      </div>
                    )}
                    <div className="grid gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                      <span>{project.domains?.length ?? 0} {(project.domains?.length ?? 0) === 1 ? 'Domain' : 'Domains'}</span>
                      <span>{project.activeDeploymentId
                        ? t('Production deployment active', 'Produktions-Deployment aktiv')
                        : t('No production deployment yet', 'Noch kein Produktions-Deployment')}</span>
                      {project.activeDeploymentId && <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono">{project.activeDeploymentId.slice(0, 8)}</code>}
                    </div>
                  </CardContent>
                </Card>

                <Card className="min-w-0">
                <CardHeader className="border-b">
                  <CardTitle>{t('Latest deployment', 'Letztes Deployment')}</CardTitle>
                  <CardDescription>{latestDeployment ? formatRelative(latestDeployment.createdAt ?? latestDeployment.startedAt, locale) : t('No activity yet', 'Noch keine Aktivität')}</CardDescription>
                  <CardAction><Button variant="ghost" size="sm" onClick={() => setActiveTab('deployments')}>{t('View all', 'Alle ansehen')} <ChevronRight /></Button></CardAction>
                </CardHeader>
                <CardContent className="p-2">
                  {latestDeployment ? (
                    <Link
                      to={`/projects/${project.id}/deployments/${latestDeployment.id}`}
                      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-lg p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40"
                    >
                      <span className="min-w-0">
                        <span className="mb-2 flex flex-wrap items-center gap-2">
                          <StatusBadge status={latestDeployment.status} />
                          {project.activeDeploymentId === latestDeployment.id && <Badge variant="secondary">{t('Production', 'Produktion')}</Badge>}
                        </span>
                        <strong className="block truncate text-sm font-medium">{deploymentSourceLabel(latestDeployment, project)}</strong>
                        <small className="mt-1 block truncate text-xs text-muted-foreground">{formatDate(latestDeployment.startedAt ?? latestDeployment.createdAt, locale)} · {formatDuration(latestDeployment.durationSeconds)}</small>
                      </span>
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </Link>
                  ) : (
                    <Empty className="min-h-36">
                      <EmptyMedia variant="icon"><Box /></EmptyMedia>
                      <EmptyHeader><EmptyTitle>{t('No deployment yet', 'Noch kein Deployment')}</EmptyTitle></EmptyHeader>
                    </Empty>
                  )}
                </CardContent>
                </Card>

                <Card className="min-w-0">
                  <CardHeader className="border-b">
                    <CardTitle>{t('Configuration', 'Konfiguration')}</CardTitle>
                    <CardDescription>{t('The most important build settings', 'Die wichtigsten Build-Einstellungen')}</CardDescription>
                    <CardAction><Button variant="ghost" size="sm" onClick={() => setActiveTab('settings')}>{t('Edit', 'Bearbeiten')}</Button></CardAction>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-4 text-sm">
                      <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">{t('Source', 'Quelle')}</dt><dd className="max-w-[65%] truncate text-right font-medium">{project.sourceType === 'git' ? t('Git repository', 'Git-Repository') : fileStorage ? t('File upload', 'Datei-Upload') : t('Direct upload', 'Direkt-Upload')}</dd></div>
                      {project.sourceType === 'git' && <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">Branch</dt><dd className="max-w-[65%] truncate text-right font-mono font-medium">{manualDeployBranch}</dd></div>}
                      <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">Build</dt><dd className="max-w-[65%] truncate text-right font-medium">{displayBuildType(project)}</dd></div>
                      {supportsStaticBasePath && <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">{t('Hosting path', 'Hosting-Pfad')}</dt><dd className="max-w-[65%] truncate text-right font-mono font-medium">{project.staticBasePath ?? t('Automatic', 'Automatisch')}</dd></div>}
                    </dl>
                  </CardContent>
                </Card>
              </aside>

              {project.activeDeploymentId && !deletionFailed && (
                <div className="min-w-0 2xl:col-start-1 2xl:row-start-1">
                  <ProjectPreviewCard project={project} publicUrl={primaryUrl} />
                </div>
              )}
            </div>
          </motion.div>
        </TabsContent>

        <TabsContent value="observability" className="grid min-w-0 gap-5">
          <motion.section initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="grid min-w-0 gap-5">
            <SectionHeading
              eyebrow={t('Production runtime', 'Produktions-Laufzeit')}
              title={t('Project observability', 'Projekt-Observability')}
              description={t('Resource usage, container health, and near-live output for the active deployment.', 'Ressourcennutzung, Containerzustand und nahezu aktuelle Ausgabe des aktiven Deployments.')}
              action={<Badge variant="outline" className="gap-2"><Activity className="size-3.5" /> {t('Worker-collected', 'Vom Worker erfasst')}</Badge>}
            />
            <ProjectObservabilityTab project={project} onOpenSettings={() => setActiveTab('settings')} />
          </motion.section>
        </TabsContent>

        <TabsContent value="deployments" className="grid min-w-0 gap-5">
          <motion.section className="grid min-w-0 gap-5" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            <SectionHeading
              eyebrow={fileStorage ? t('File storage', 'Dateiablage') : 'Builds'}
              title={fileStorage ? t('Version history', 'Versionsverlauf') : 'Deployments'}
              description={fileStorage
                ? t('Every upload or republish creates a separate version with status and full output.', 'Jeder Upload oder jede erneute Veröffentlichung erstellt eine eigene Version mit Status und vollständiger Ausgabe.')
                : project.sourceType === 'git'
                  ? <>{t('The button fetches the latest commit from the saved branch', 'Der Button lädt den neuesten Commit des gespeicherten Branches')} <code className="font-mono text-foreground">{manualDeployBranch}</code>. {t('Auto-deploy remains independent of this.', 'Auto-Deploy bleibt davon unabhängig.')}</>
                  : t('Every build has its own detail page with status, metadata, and full output.', 'Jeder Build hat eine eigene Detailseite mit Status, Metadaten und vollständiger Ausgabe.')}
              action={project.sourceType === 'upload' ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => deploy.mutate(undefined)} loading={deploy.isPending} disabled={deploymentActive || deletionFailed}>
                    {fileStorage ? t('Republish current files', 'Aktuelle Dateien neu veröffentlichen') : t('Redeploy current source', 'Aktuelle Quelle neu deployen')}
                  </Button>
                  {deletionFailed ? <Button disabled><UploadCloud /> {t('New version', 'Neue Version')}</Button> : <Button asChild><Link to={`/projects/${project.id}/upload`}><UploadCloud /> {t('New version', 'Neue Version')}</Link></Button>}
                </div>
              ) : project.sourceType === 'git' ? (
                <Button onClick={() => deploy.mutate(undefined)} loading={deploy.isPending} disabled={deploymentActive || deletionFailed}>
                  {!deploy.isPending && <Rocket />} {t('Deploy latest', 'Aktuellen Stand deployen')}
                </Button>
              ) : null}
            />

            {project.sourceType === 'upload' && deploy.isError && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>{fileStorage
                  ? t('Version could not be published', 'Version konnte nicht veröffentlicht werden')
                  : t('Deployment could not be started', 'Deployment konnte nicht gestartet werden')}</AlertTitle>
                <AlertDescription>{deploy.error instanceof Error ? deploy.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription>
              </Alert>
            )}

            <Card className="min-w-0">
              <CardHeader className="border-b">
                <CardTitle>{fileStorage ? t('Version history', 'Versionsverlauf') : t('Deployment history', 'Deployment-Verlauf')}</CardTitle>
                <CardDescription>
                  {fileStorage
                    ? deployments.length === 50
                      ? t('The latest 50 versions of this file storage', 'Die neuesten 50 Versionen dieser Dateiablage')
                      : deployments.length === 1
                        ? t('1 version of this file storage', '1 Version dieser Dateiablage')
                        : t('{count} versions of this file storage', '{count} Versionen dieser Dateiablage', { count: deployments.length })
                    : deployments.length === 50
                      ? t('The latest 50 builds for this project', 'Die neuesten 50 Builds für dieses Projekt')
                      : t(
                        `${deployments.length} ${deployments.length === 1 ? 'build' : 'builds'} for this project`,
                        `${deployments.length} ${deployments.length === 1 ? 'Build' : 'Builds'} für dieses Projekt`,
                      )}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-2">
                {deployments.length > 0 ? (
                  <ol className="grid gap-1">
                    {deployments.map((deployment) => (
                      <li key={deployment.id}>
                        <Link
                          to={`/projects/${project.id}/deployments/${deployment.id}`}
                          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-3.5 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                        >
                          <span className="min-w-0">
                            <span className="mb-2 flex flex-wrap items-center gap-2">
                              <StatusBadge status={deployment.status} />
                              {project.activeDeploymentId === deployment.id && <Badge variant="secondary">{t('Production', 'Produktion')}</Badge>}
                              {deployment.trigger === 'github_push' && <Badge variant="outline">GitHub Push</Badge>}
                              {deployment.failureKind === 'timeout' && <Badge variant="outline">Timeout</Badge>}
                              {deployment.rollbackStatus === 'automatic_succeeded' && (
                                <Badge variant="outline" className="border-success/30 text-success">{t('Auto-recovered', 'Auto-Wiederherstellung')}</Badge>
                              )}
                              {deployment.rollbackStatus === 'automatic_failed' && (
                                <Badge variant="outline" className="border-destructive/30 text-destructive">{t('Recovery failed', 'Wiederherstellung fehlgeschlagen')}</Badge>
                              )}
                            </span>
                            <strong className="block truncate text-sm font-medium">{deploymentSourceLabel(deployment, project)}</strong>
                            {deployment.commitMessage && <small className="mt-1 block truncate text-xs text-muted-foreground">{deployment.commitMessage}</small>}
                            <small className="mt-1 block truncate font-mono text-xs text-muted-foreground">{deployment.commitSha?.slice(0, 8) ?? deployment.id.slice(0, 8)}{deployment.commitAuthor ? ` · ${deployment.commitAuthor}` : ''} · {formatRelative(deployment.createdAt ?? deployment.startedAt, locale)}</small>
                            {deployment.status === 'failed' && deployment.error && <small className="mt-1 block truncate text-xs text-destructive">{deployment.error}</small>}
                          </span>
                          <span className="hidden text-right text-xs text-muted-foreground sm:block">
                            <span className="block">{formatDate(deployment.startedAt ?? deployment.createdAt, locale)}</span>
                            <span className="mt-1 flex items-center justify-end gap-1"><Clock3 className="size-3.5" /> {formatDuration(deployment.durationSeconds)}</span>
                          </span>
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </Link>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty className="min-h-64">
                    <EmptyMedia variant="icon"><Rocket /></EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>{fileStorage ? t('No versions yet', 'Noch keine Versionen') : t('No deployments yet', 'Noch keine Deployments')}</EmptyTitle>
                      <EmptyDescription>{fileStorage
                        ? t('Upload the first version of this file storage.', 'Lade die erste Version dieser Dateiablage hoch.')
                        : project.sourceType === 'git'
                          ? t(`Deploy the latest state of “${manualDeployBranch}”.`, `Deploye den aktuellen Stand von „${manualDeployBranch}“.`)
                          : t('Start the first build for this project.', 'Starte den ersten Build für dieses Projekt.')}</EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      {project.sourceType === 'upload' ? (
                        <Button asChild><Link to={`/projects/${project.id}/upload`}>{t('Upload version', 'Version hochladen')}</Link></Button>
                      ) : project.sourceType === 'git' ? (
                        <Button onClick={() => deploy.mutate(undefined)} loading={deploy.isPending} disabled={deploymentActive || deletionFailed}>
                          {!deploy.isPending && <Rocket />} {t('Deploy latest', 'Aktuellen Stand deployen')}
                        </Button>
                      ) : null}
                    </EmptyContent>
                  </Empty>
                )}
              </CardContent>
            </Card>
          </motion.section>
        </TabsContent>

        <TabsContent value="domains">
          <motion.section className="grid gap-5" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            <SectionHeading
              eyebrow="Cloudflare"
              title="Domains"
              description={t('Connect a hostname route through Cloudflare Tunnel without opening a public port on the server.', 'Verbinde eine Hostname-Route über Cloudflare Tunnel, ohne einen öffentlichen Port am Server zu öffnen.')}
              action={(project.domains?.length ?? 0) > 0 ? (
                <Button variant={domainFormOpen ? 'ghost' : 'outline'} onClick={() => {
                  addDomain.reset();
                  setDomainToReplace(undefined);
                  setDomainMode('subdomain');
                  setSubdomain('');
                  setDomainFormOpen((open) => !open);
                }}>
                  {domainFormOpen ? <><X /> {t('Close form', 'Formular schließen')}</> : <><Plus /> {t('Add domain', 'Domain hinzufügen')}</>}
                </Button>
              ) : undefined}
            />

            {(project.domains?.length ?? 0) > 0 && (
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>{t('Connected domains', 'Verbundene Domains')}</CardTitle>
                  <CardDescription>{t(
                    `${project.domains?.length ?? 0} connected ${(project.domains?.length ?? 0) === 1 ? 'hostname route' : 'hostname routes'}`,
                    `${project.domains?.length ?? 0} verknüpfte ${(project.domains?.length ?? 0) === 1 ? 'Hostname-Route' : 'Hostname-Routen'}`,
                  )}</CardDescription>
                </CardHeader>
                <CardContent className="divide-y">
                  {project.domains?.map((domain) => (
                    <article className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-3 first:pt-0 last:pb-0" key={domain.id}>
                      <Globe2 className="mt-1 size-4 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0">
                        <strong className="block truncate text-sm font-medium">{domain.hostname}</strong>
                        <span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">{domain.status === 'active'
                          ? t('HTTPS active · via tunnel', 'HTTPS aktiv · via Tunnel')
                          : domain.status === 'error'
                            ? domain.error ?? t('Setup failed', 'Einrichtung fehlgeschlagen')
                            : t('Setting up DNS/tunnel', 'DNS/Tunnel wird eingerichtet')}</span>
                        <StatusBadge status={domain.status} className="mt-2" />
                      </div>
                      <div className="flex items-center gap-1">
                        <Button asChild variant="ghost" size="icon" aria-label={t(`Open ${domain.hostname}`, `${domain.hostname} öffnen`)}>
                          <a href={domain.url ?? safeUrl(domain.hostname)} target="_blank" rel="noreferrer"><ExternalLink /></a>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => beginDomainReplacement(domain)}
                          disabled={addDomain.isPending || removeDomain.isPending || deletionFailed}
                          aria-label={t(`Change ${domain.hostname}`, `${domain.hostname} ändern`)}
                        >
                          <Pencil />
                        </Button>
                        <Button variant="ghost" size="icon" className="text-destructive" onClick={() => { removeDomain.reset(); setDomainToRemove(domain); }} disabled={removeDomain.isPending || deletionFailed} aria-label={t(`Remove ${domain.hostname}`, `${domain.hostname} entfernen`)}><Trash2 /></Button>
                      </div>
                    </article>
                  ))}
                </CardContent>
              </Card>
            )}

            {((project.domains?.length ?? 0) === 0 || domainFormOpen) && (
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>{domainToReplace
                    ? t('Replace domain', 'Domain ersetzen')
                    : (project.domains?.length ?? 0) === 0
                      ? t('Connect first domain', 'Erste Domain verbinden')
                      : t('Add domain', 'Domain hinzufügen')}</CardTitle>
                  <CardDescription>{domainToReplace
                    ? t(`The new domain is activated first; Shelter then removes ${domainToReplace.hostname}.`, `Die neue Domain wird zuerst aktiviert; danach entfernt Shelter ${domainToReplace.hostname}.`)
                    : t('Shelter checks availability before every DNS change.', 'Shelter prüft die Verfügbarkeit vor jeder DNS-Änderung.')}</CardDescription>
                  <CardAction><Badge variant="secondary"><Cloud /> Cloudflare DNS</Badge></CardAction>
                </CardHeader>
                <CardContent>
                  <form className="grid gap-5" onSubmit={submitDomain}>
                    <div className="grid gap-2">
                      <Label>{t('Domain type', 'Domain-Typ')}</Label>
                      <RadioGroup
                        className="grid gap-3 sm:grid-cols-2"
                        value={domainMode}
                        onValueChange={(value) => {
                          if (addDomain.isError) addDomain.reset();
                          setDomainMode(value as DomainMode);
                        }}
                        disabled={addDomain.isPending}
                        aria-label={t('Domain type', 'Domain-Typ')}
                      >
                        <Label
                          htmlFor="domain-mode-apex"
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/50 ${domainMode === 'apex' ? 'border-primary bg-accent/60' : ''}`}
                        >
                          <RadioGroupItem id="domain-mode-apex" value="apex" className="mt-0.5" />
                          <span className="grid gap-1">
                            <strong className="text-sm font-medium">{t('Apex domain', 'Hauptdomain')}</strong>
                            <span className="text-xs font-normal leading-relaxed text-muted-foreground">{t(`Use ${selectedZone?.name ?? 'domain.tld'} directly`, `Direkt ${selectedZone?.name ?? 'domain.tld'} verwenden`)}</span>
                          </span>
                        </Label>
                        <Label
                          htmlFor="domain-mode-subdomain"
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-accent/50 ${domainMode === 'subdomain' ? 'border-primary bg-accent/60' : ''}`}
                        >
                          <RadioGroupItem id="domain-mode-subdomain" value="subdomain" className="mt-0.5" />
                          <span className="grid gap-1">
                            <strong className="text-sm font-medium">Subdomain</strong>
                            <span className="text-xs font-normal leading-relaxed text-muted-foreground">{t(`For example app.${selectedZone?.name ?? 'domain.tld'}`, `Zum Beispiel app.${selectedZone?.name ?? 'domain.tld'}`)}</span>
                          </span>
                        </Label>
                      </RadioGroup>
                    </div>

                    <div className={domainMode === 'subdomain' ? 'grid items-start gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]' : 'grid items-start gap-3'}>
                      {domainMode === 'subdomain' && (
                        <>
                          <Field
                            label="Subdomain"
                            id="subdomain"
                            name="subdomain"
                            value={subdomain}
                            onChange={(event) => updateSubdomain(event.target.value)}
                            placeholder="app"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={addDomain.isPending}
                            hint={t('Nested names are supported, e.g. preview.shop', 'Auch verschachtelt möglich, z. B. preview.shop')}
                            error={subdomain && !subdomainValid ? t('Use letters, numbers, hyphens, and dots.', 'Nutze Buchstaben, Zahlen, Bindestriche und Punkte.') : undefined}
                          />
                          <span className="hidden pt-8 text-lg text-muted-foreground md:block" aria-hidden="true">.</span>
                        </>
                      )}
                      <SelectField
                        label={t('Cloudflare domain', 'Cloudflare-Domain')}
                        id="cloudflare-zone"
                        name="cloudflare-zone"
                        value={selectedZoneId}
                        onChange={(event) => {
                          if (addDomain.isError) addDomain.reset();
                          setSelectedZoneId(event.target.value);
                        }}
                        disabled={zonesQuery.isLoading || zones.length === 0 || addDomain.isPending}
                        hint={t('Directly from your connected account', 'Direkt aus deinem verbundenen Account')}
                      >
                        {zonesQuery.isLoading && <option value="">{t('Loading domains…', 'Domains werden geladen …')}</option>}
                        {!zonesQuery.isLoading && zones.length === 0 && <option value="">{t('No active domain', 'Keine aktive Domain')}</option>}
                        {zones.map((zone) => <option value={zone.id} key={zone.id}>{zone.name}</option>)}
                      </SelectField>
                    </div>

                    <div className="border-t pt-4">
                      <span className="block text-sm text-muted-foreground">{t('Full hostname', 'Vollständiger Hostname')}</span>
                      <code className="mt-1 block break-all text-sm font-medium">
                        {candidateHostname || (domainMode === 'apex' ? selectedZone?.name ?? 'domain.tld' : `subdomain.${selectedZone?.name ?? 'domain.tld'}`)}
                      </code>
                    </div>

                    <div aria-live="polite" aria-atomic="true">
                      {addDomain.isError ? (
                        <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Domain could not be connected', 'Domain konnte nicht verbunden werden')}</AlertTitle><AlertDescription>{addDomain.error instanceof Error ? addDomain.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>
                      ) : zonesQuery.isLoading ? (
                        <Alert role="status"><LoaderCircle className="animate-spin" /><AlertTitle>{t('Loading Cloudflare domains', 'Cloudflare-Domains werden geladen')}</AlertTitle><AlertDescription>{t('Fetching active zones.', 'Aktive Zonen werden abgefragt.')}</AlertDescription></Alert>
                      ) : zonesQuery.isError ? (
                        <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Domains could not be loaded', 'Domains konnten nicht geladen werden')}</AlertTitle><AlertDescription>{zonesQuery.error instanceof Error ? zonesQuery.error.message : t('Check the Cloudflare connection.', 'Prüfe die Cloudflare-Verbindung.')}</AlertDescription><Button type="button" variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={() => zonesQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button></Alert>
                      ) : zones.length === 0 ? (
                        <Alert><AlertTriangle /><AlertTitle>{t('No active Cloudflare domain found', 'Keine aktive Cloudflare-Domain gefunden')}</AlertTitle><AlertDescription>{t('Connect an account with at least one active zone.', 'Verbinde einen Account mit mindestens einer aktiven Zone.')}</AlertDescription><Button asChild variant="outline" size="sm" className="col-start-2 mt-2 w-fit"><Link to="/settings">{t('Go to settings', 'Zu Einstellungen')}</Link></Button></Alert>
                      ) : domainMode === 'subdomain' && subdomain && !subdomainValid ? (
                        <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Subdomain is invalid', 'Subdomain ist ungültig')}</AlertTitle><AlertDescription>{t('Do not begin or end with a hyphen.', 'Nicht mit einem Bindestrich beginnen oder enden.')}</AlertDescription></Alert>
                      ) : availabilityPending ? (
                        <Alert role="status"><LoaderCircle className="animate-spin" /><AlertTitle>{t('Checking availability', 'Verfügbarkeit wird geprüft')}</AlertTitle><AlertDescription>{candidateHostname}</AlertDescription></Alert>
                      ) : availabilityQuery.isError && debouncedHostname === candidateHostname ? (
                        <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Check failed', 'Prüfung fehlgeschlagen')}</AlertTitle><AlertDescription>{availabilityQuery.error instanceof Error ? availabilityQuery.error.message : t('Cloudflare is currently unavailable.', 'Cloudflare ist gerade nicht erreichbar.')}</AlertDescription></Alert>
                      ) : checkedAvailability?.availability ? (
                        <Alert role="status" className="border-success/25 bg-success/8 text-foreground"><CheckCircle2 className="text-success" /><AlertTitle>{t('Hostname is available', 'Hostname ist verfügbar')}</AlertTitle><AlertDescription>{availabilityMessage(checkedAvailability.reason, checkedAvailability.message)}</AlertDescription></Alert>
                      ) : checkedAvailability ? (
                        <Alert variant="destructive"><AlertTriangle /><AlertTitle>{unavailabilityTitle(checkedAvailability.reason)}</AlertTitle><AlertDescription>{availabilityMessage(checkedAvailability.reason, checkedAvailability.message)}</AlertDescription></Alert>
                      ) : (
                        <Alert role="status"><Cloud /><AlertTitle>{t('Ready to check', 'Bereit zur Prüfung')}</AlertTitle><AlertDescription>{domainMode === 'apex'
                          ? t('Select a Cloudflare domain; Shelter checks the apex domain live.', 'Wähle eine Cloudflare-Domain; Shelter prüft die Hauptdomain live.')
                          : t('Enter a subdomain; Shelter checks it live in Cloudflare.', 'Gib eine Subdomain ein; Shelter prüft sie live in Cloudflare.')}</AlertDescription></Alert>
                      )}
                    </div>

                    <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t pt-4 sm:flex-row sm:items-center">
                      <span className="text-xs text-muted-foreground">{t('DNS is created only when you connect the domain.', 'DNS wird erst beim Verbinden angelegt.')}</span>
                      <Button type="submit" loading={addDomain.isPending} disabled={!canConnectDomain}>
                        {domainToReplace ? <Pencil /> : <Plus />} {domainToReplace ? t('Replace domain safely', 'Domain sicher ersetzen') : t('Connect domain', 'Domain verbinden')}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}
          </motion.section>
        </TabsContent>

        <TabsContent value="environment">
          <motion.section className="grid gap-5" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            <SectionHeading
              eyebrow={t('Configuration', 'Konfiguration')}
              title={t('Environment variables', 'Umgebungsvariablen')}
              description={fileStorage
                ? t('Values remain encrypted and available for a later application runtime.', 'Werte bleiben verschlüsselt und für eine spätere App-Laufzeit verfügbar.')
                : t('Values are stored encrypted and take effect with the next deployment.', 'Werte werden verschlüsselt gespeichert und mit dem nächsten Deployment wirksam.')}
            />
            {fileStorage && (
              <Alert role="note">
                <KeyRound />
                <AlertTitle>{t('File storage does not receive environment variables', 'Dateiablagen erhalten keine Umgebungsvariablen')}</AlertTitle>
                <AlertDescription>{t(
                  'Saved values stay available if you later switch to Node.js or Dockerfile. Uploading or republishing files does not inject them into the active file storage.',
                  'Gespeicherte Werte bleiben verfügbar, falls du später zu Node.js oder Dockerfile wechselst. Beim Hochladen oder erneuten Veröffentlichen werden sie nicht in die aktive Dateiablage injiziert.',
                )}</AlertDescription>
              </Alert>
            )}
            <Alert role="note">
              <ShieldAlert />
              <AlertTitle>{t('Secret values stay private', 'Secret-Werte bleiben privat')}</AlertTitle>
              <AlertDescription>{t('Existing values are never sent back to the browser. An empty value field leaves a secret unchanged.', 'Bestehende Werte werden nie an den Browser zurückgesendet. Ein leeres Wertefeld lässt ein Secret unverändert.')}</AlertDescription>
            </Alert>

            <Card>
              <CardHeader className="border-b">
                <CardTitle>{t('Runtime environment', 'Runtime-Umgebung')}</CardTitle>
                <CardDescription>{fileStorage
                  ? t('Manage encrypted values for a future application runtime.', 'Verwalte verschlüsselte Werte für eine spätere App-Laufzeit.')
                  : t('Changes take effect with the next deployment.', 'Änderungen werden mit dem nächsten Deployment wirksam.')}</CardDescription>
                <CardAction><Badge variant="secondary"><KeyRound /> {t('encrypted', 'verschlüsselt')}</Badge></CardAction>
              </CardHeader>
              <CardContent className="grid gap-4">
                {environment.length > 0 ? environment.map((variable, index) => (
                  <div className="grid gap-3 border-b py-4 first:pt-0 last:border-b-0 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1.2fr)_auto] sm:items-start" key={`${variable.key}-${index}`}>
                    <div className="grid gap-2">
                      <Label htmlFor={`environment-key-${index}`} className="text-sm font-medium">Variable</Label>
                      <Input
                        id={`environment-key-${index}`}
                        aria-label={t(`Variable ${index + 1} name`, `Name Variable ${index + 1}`)}
                        aria-invalid={Boolean(environmentErrors[index]) || undefined}
                        aria-describedby={environmentErrors[index] ? `environment-error-${index}` : undefined}
                        value={variable.key}
                        onChange={(event) => setEnvironment((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : item))}
                        placeholder="API_KEY"
                        className="font-mono"
                        disabled={saveEnvironment.isPending}
                        maxLength={MAX_ENVIRONMENT_KEY_LENGTH}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor={`environment-value-${index}`} className="text-sm font-medium">{t('New value', 'Neuer Wert')}</Label>
                      <Input
                        id={`environment-value-${index}`}
                        aria-label={t(`Variable ${index + 1} value`, `Wert Variable ${index + 1}`)}
                        aria-invalid={Boolean(environmentErrors[index]) || undefined}
                        aria-describedby={environmentErrors[index] ? `environment-error-${index}` : undefined}
                        type="password"
                        autoComplete="new-password"
                        value={variable.value ?? ''}
                        onChange={(event) => setEnvironment((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))}
                        placeholder={project.environmentKeys?.includes(variable.key) ? t('••••••••  unchanged', '••••••••  unverändert') : t('Enter secret', 'Secret eingeben')}
                        className="font-mono"
                        disabled={saveEnvironment.isPending}
                        maxLength={MAX_ENVIRONMENT_VALUE_LENGTH}
                      />
                      {environmentErrors[index] && <p className="text-xs text-destructive" id={`environment-error-${index}`} role="alert">{environmentErrors[index]}</p>}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-10 w-full text-muted-foreground hover:text-destructive sm:mt-6 sm:size-8 sm:px-0"
                      type="button"
                      onClick={() => requestEnvironmentRemoval(index)}
                      disabled={saveEnvironment.isPending}
                      aria-label={t(`Remove ${variable.key || 'variable'}`, `${variable.key || 'Variable'} entfernen`)}
                    >
                      <X /> <span className="sm:sr-only">{t('Remove variable', 'Variable entfernen')}</span>
                    </Button>
                  </div>
                )) : (
                  <Empty className="min-h-44">
                    <EmptyMedia variant="icon"><KeyRound /></EmptyMedia>
                    <EmptyHeader><EmptyTitle>{t('No variables yet', 'Noch keine Variablen')}</EmptyTitle><EmptyDescription>{t('Only add values your application needs at runtime.', 'Füge nur Werte hinzu, die deine Anwendung zur Laufzeit benötigt.')}</EmptyDescription></EmptyHeader>
                  </Empty>
                )}

                <Button variant="outline" className="w-fit" type="button" onClick={() => setEnvironment((current) => [...current, { key: '', value: '' }])} disabled={saveEnvironment.isPending || environment.length >= MAX_ENVIRONMENT_VARIABLES}><Plus /> {t('Add variable', 'Variable hinzufügen')}</Button>

                {!environmentValid && environment.length > 0 && (
                  <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Check the highlighted variables', 'Bitte prüfe die markierten Variablen')}</AlertTitle><AlertDescription>{environmentGlobalError ?? t('Every name must be unique; new variables require a value.', 'Jeder Name muss eindeutig sein; neue Variablen benötigen einen Wert.')}</AlertDescription></Alert>
                )}
                {saveEnvironment.isError && (
                  <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Environment could not be saved', 'Umgebung konnte nicht gespeichert werden')}</AlertTitle><AlertDescription>{saveEnvironment.error instanceof Error ? saveEnvironment.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>
                )}
              </CardContent>
              <CardFooter className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
                <span className="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound className="size-3.5" /> {t('Secrets are stored encrypted', 'Secrets werden verschlüsselt gespeichert')}</span>
                <Button onClick={() => saveEnvironment.mutate()} loading={saveEnvironment.isPending} disabled={!environmentValid || !environmentDirty || deletionFailed}>{t('Save changes', 'Änderungen speichern')}</Button>
              </CardFooter>
            </Card>
          </motion.section>
        </TabsContent>

        <TabsContent value="settings">
          <motion.section className="grid gap-5" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
            <SectionHeading eyebrow={t('Project management', 'Projektverwaltung')} title={t('Settings', 'Einstellungen')} description={t('Edit project, source, build, and runtime. Changes become active with the next deployment.', 'Bearbeite Projekt, Quelle, Build und Laufzeit. Änderungen werden mit dem nächsten Deployment aktiv.')} />

            {project.sourceType === 'git' && (
              <ProjectGitHubConnection
                project={project}
                disabled={project.status === 'deploying' || deletionFailed}
                onUpdated={(updated) => {
                  queryClient.setQueryData(['project', id], updated);
                  settingsInitialized.current = updated.id;
                  setSettings(projectSettingsDraft(updated));
                  invalidateProject();
                }}
                onDirtyChange={setGithubSettingsDirty}
              />
            )}

            <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); if (settingsValid && settingsDirty) saveSettings.mutate(); }}>
              <Card>
                <CardHeader className="border-b">
                  <CardTitle>{t('Project and source', 'Projekt und Quelle')}</CardTitle>
                  <CardDescription>{t('Name and origin of this project.', 'Name und Ursprung dieses Projekts.')}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5 sm:grid-cols-2">
                  <Field
                    id="project-settings-name"
                    label={t('Project name', 'Projektname')}
                    value={settings.name}
                    onChange={(event) => setSettings((current) => ({ ...current, name: event.target.value }))}
                    error={settingsErrors.name}
                    maxLength={80}
                    disabled={saveSettings.isPending || deletionFailed}
                  />
                  {project.sourceType === 'git' && !project.github && (
                    <Field
                      id="project-settings-branch"
                      label={t('Git branch', 'Git-Branch')}
                      value={settings.repositoryBranch}
                      onChange={(event) => setSettings((current) => ({ ...current, repositoryBranch: event.target.value }))}
                      error={settingsErrors.repositoryBranch}
                      maxLength={160}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                    />
                  )}
                  {project.sourceType === 'git' && !project.github && (
                    <Field
                      id="project-settings-repository"
                      label={t('Repository URL', 'Repository-URL')}
                      type="url"
                      value={settings.repositoryUrl}
                      onChange={(event) => setSettings((current) => ({ ...current, repositoryUrl: event.target.value }))}
                      error={settingsErrors.repositoryUrl}
                      hint={t('Public HTTPS repository without credentials in the URL', 'Öffentliches HTTPS-Repository ohne Zugangsdaten in der URL')}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                      className="sm:col-span-2"
                    />
                  )}
                  {project.github && (
                    <div className="grid gap-2 sm:col-span-2">
                      <Label>{t('Repository source', 'Repository-Quelle')}</Label>
                      <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4">
                        <div className="min-w-0">
                          <strong className="block truncate text-sm font-medium">{project.github.fullName}</strong>
                          <p className="mt-1 text-xs text-muted-foreground">{t('Repository and branch are managed in the GitHub section above.', 'Repository und Branch werden im GitHub-Bereich oberhalb verwaltet.')}</p>
                        </div>
                        <Badge variant="secondary" className="shrink-0">GitHub App</Badge>
                      </div>
                    </div>
                  )}
                  {project.sourceType === 'upload' && (
                    <div className="grid gap-2 sm:col-span-2">
                      <Label>{t('Source files', 'Quelldateien')}</Label>
                      <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <strong className="text-sm font-medium">{t('Directly uploaded archive', 'Direkt hochgeladenes Archiv')}</strong>
                          <p className="mt-1 text-xs text-muted-foreground">{t('Replace the files with a new, validated upload.', 'Ersetze die Dateien über einen neuen, geprüften Upload.')}</p>
                        </div>
                        <Button asChild variant="outline" className="shrink-0">
                          <Link to={`/projects/${project.id}/upload`}><UploadCloud /> {t('Upload new version', 'Neue Version hochladen')}</Link>
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <CardTitle>{t('Build and runtime', 'Build und Laufzeit')}</CardTitle>
                  <CardDescription>{t('Controls detection, build context, and health checks.', 'Steuert Erkennung, Build-Kontext und Healthcheck.')}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5 sm:grid-cols-2">
                  <SelectField
                    id="project-settings-build-type"
                    label={t('Build type', 'Build-Typ')}
                    value={settings.buildType}
                    onChange={(event) => {
                      const buildType = event.target.value as ProjectBuildType;
                      setSettings((current) => ({
                        ...current,
                        buildType,
                        staticBasePath: buildType === 'node' || buildType === 'dockerfile' ? null : current.staticBasePath,
                      }));
                    }}
                    disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                  >
                    <option value="auto">{t('Detect automatically', 'Automatisch erkennen')}</option>
                    <option value="static">{t('Static website', 'Statische Website')}</option>
                    <option value="node">Node.js / Next.js</option>
                    <option value="dockerfile">Dockerfile</option>
                  </SelectField>
                  <Field
                    id="project-settings-root-directory"
                    label={t('Project directory', 'Projektverzeichnis')}
                    value={settings.rootDirectory}
                    onChange={(event) => setSettings((current) => ({ ...current, rootDirectory: event.target.value }))}
                    error={settingsErrors.rootDirectory}
                    hint={t('Relative to the repository or archive root, usually .', 'Relativ zum Repository- oder Archiv-Root, meist .')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                  />
                  {settings.buildType === 'dockerfile' && (
                    <Field
                      id="project-settings-dockerfile"
                      label={t('Dockerfile path', 'Dockerfile-Pfad')}
                      value={settings.dockerfilePath}
                      onChange={(event) => setSettings((current) => ({ ...current, dockerfilePath: event.target.value }))}
                      error={settingsErrors.dockerfilePath}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                    />
                  )}
                  {managedFileStorageRuntime ? (
                    <Alert role="note" className="sm:col-span-2">
                      <Box />
                      <AlertTitle>{t('Managed file runtime', 'Verwaltete Datei-Laufzeit')}</AlertTitle>
                      <AlertDescription>{t(
                        'Shelter serves this file storage through its fixed internal web runtime on port 8080 and checks /. Application port and health-check path cannot be changed for this runtime.',
                        'Shelter stellt diese Dateiablage über seine feste interne Web-Laufzeit auf Port 8080 bereit und prüft /. Anwendungs-Port und Healthcheck-Pfad sind für diese Laufzeit nicht änderbar.',
                      )}</AlertDescription>
                    </Alert>
                  ) : (
                    <>
                      <Field
                        id="project-settings-port"
                        label={t('Application port', 'Anwendungs-Port')}
                        type="number"
                        min={1}
                        max={65_535}
                        step={1}
                        value={settings.port}
                        onChange={(event) => setSettings((current) => ({ ...current, port: event.target.value }))}
                        error={settingsErrors.port}
                        hint={t('Fallback for Node and Docker runtimes', 'Fallback für Node- und Docker-Laufzeiten')}
                        disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                      />
                      <Field
                        id="project-settings-healthcheck"
                        label={t('Health check path', 'Healthcheck-Pfad')}
                        value={settings.healthcheckPath}
                        onChange={(event) => setSettings((current) => ({ ...current, healthcheckPath: event.target.value }))}
                        error={settingsErrors.healthcheckPath}
                        placeholder="/"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                      />
                    </>
                  )}
                  <Field
                    id="project-settings-memory"
                    label={t('Memory limit', 'Arbeitsspeicher-Limit')}
                    value={settings.memoryLimit}
                    onChange={(event) => setSettings((current) => ({ ...current, memoryLimit: event.target.value }))}
                    error={settingsErrors.memoryLimit}
                    hint={t('For example 512m or 2g', 'Zum Beispiel 512m oder 2g')}
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                  />
                  <Field
                    id="project-settings-cpu"
                    label={t('CPU limit', 'CPU-Limit')}
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={settings.cpuLimit}
                    onChange={(event) => setSettings((current) => ({ ...current, cpuLimit: event.target.value }))}
                    error={settingsErrors.cpuLimit}
                    hint={t('For example 0.5 or 2', 'Zum Beispiel 0.5 oder 2')}
                    disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                  />
                  {settingsSupportsStaticBasePath && (
                    <StaticBasePathControl
                      id="settings-static-base-path"
                      value={settings.staticBasePath}
                      onChange={(staticBasePath) => setSettings((current) => ({ ...current, staticBasePath }))}
                      disabled={saveSettings.isPending || project.status === 'deploying' || deletionFailed}
                      className="sm:col-span-2"
                    />
                  )}
                </CardContent>
                <CardFooter className="flex flex-col items-stretch justify-between gap-3 border-t bg-muted/20 sm:flex-row sm:items-center">
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {project.status === 'deploying'
                      ? t('Build settings are locked during a deployment.', 'Build-Einstellungen sind während eines Deployments gesperrt.')
                      : t('The running version stays unchanged until you deploy again.', 'Die laufende Version bleibt unverändert, bis du neu deployst.')}
                  </span>
                  <Button
                    type="submit"
                    className="shrink-0"
                    loading={saveSettings.isPending}
                    disabled={!settingsDirty || !settingsValid || project.status === 'deploying' || deletionFailed}
                  >
                    {!saveSettings.isPending && <Save />} {t('Save project', 'Projekt speichern')}
                  </Button>
                </CardFooter>
              </Card>

              {saveSettings.isError && (
                <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Project could not be saved', 'Projekt konnte nicht gespeichert werden')}</AlertTitle><AlertDescription>{saveSettings.error instanceof Error ? saveSettings.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>
              )}
            </form>

            <Card className="border-destructive/25">
              <CardHeader>
                <CardTitle>{deletionFailed ? t('Run cleanup again', 'Cleanup erneut ausführen') : t('Permanently delete project', 'Projekt dauerhaft löschen')}</CardTitle>
                <CardDescription className="max-w-3xl leading-relaxed">{deletionFailed
                  ? t('The project remains disconnected from public routing until all managed resources have been cleaned up safely.', 'Das Projekt bleibt vom öffentlichen Routing getrennt, bis alle verwalteten Ressourcen sicher bereinigt wurden.')
                  : t('Removes the application, deployments, logs, secrets, source data, and all DNS records managed by Shelter for this project.', 'Entfernt Anwendung, Deployments, Logs, Secrets, Quelldaten und alle von Shelter verwalteten DNS-Einträge dieses Projekts.')}</CardDescription>
                <CardAction><ShieldAlert className="size-4 text-destructive" aria-hidden="true" /></CardAction>
                <Button className="mt-3 w-fit" variant="danger" onClick={() => { deleteProject.reset(); setDeleteConfirmation(''); setDeleteOpen(true); }}>
                  <Trash2 /> {deletionFailed ? t('Retry cleanup…', 'Cleanup wiederholen …') : t('Delete project…', 'Projekt löschen …')}
                </Button>
              </CardHeader>
            </Card>
          </motion.section>
        </TabsContent>
      </Tabs>

      <AlertDialog open={Boolean(domainToRemove)} onOpenChange={(open) => {
        if (!open && !removeDomain.isPending) {
          setDomainToRemove(undefined);
          removeDomain.reset();
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive"><Trash2 /></AlertDialogMedia>
            <AlertDialogTitle>{t('Remove domain?', 'Domain entfernen?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('The route for', 'Die Route für')} <strong className="text-foreground [overflow-wrap:anywhere]">{domainToRemove?.hostname}</strong> {t('and the DNS record managed by Shelter will be removed. The project itself remains intact.', 'und der von Shelter verwaltete DNS-Eintrag werden entfernt. Das Projekt selbst bleibt bestehen.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeDomain.isError && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{t('Domain could not be removed', 'Domain konnte nicht entfernt werden')}</AlertTitle>
              <AlertDescription>{removeDomain.error instanceof Error ? removeDomain.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeDomain.isPending}>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
            <Button variant="danger" loading={removeDomain.isPending} disabled={removeDomain.isPending} onClick={() => domainToRemove && removeDomain.mutate(domainToRemove.id)}>
              {!removeDomain.isPending && <Trash2 />} {t('Remove domain', 'Domain entfernen')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={environmentRemovalIndex !== undefined} onOpenChange={(open) => !open && setEnvironmentRemovalIndex(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-warning/15 text-warning"><KeyRound /></AlertDialogMedia>
            <AlertDialogTitle>{t('Remove existing secret?', 'Bestehendes Secret entfernen?')}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="text-foreground [overflow-wrap:anywhere]">{environmentRemovalIndex !== undefined ? environment[environmentRemovalIndex]?.key : ''}</strong> {t('will be permanently removed from the project environment the next time you save. The running version changes only with the next deployment.', 'wird beim nächsten Speichern dauerhaft aus der Projektumgebung gelöscht. Die laufende Version ändert sich erst mit dem nächsten Deployment.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Keep', 'Behalten')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={saveEnvironment.isPending}
              onClick={() => {
                if (environmentRemovalIndex === undefined) return;
                setEnvironment((current) => current.filter((_, index) => index !== environmentRemovalIndex));
                setEnvironmentRemovalIndex(undefined);
                toast.info(t('Variable marked for removal', 'Variable zum Entfernen markiert'), { description: t('Save the environment to apply the change.', 'Speichere die Umgebung, um die Änderung zu übernehmen.') });
              }}
            >
              {t('Mark for removal', 'Zum Entfernen markieren')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={(open) => {
        if (deleteProject.isPending) return;
        setDeleteOpen(open);
        if (!open) {
          setDeleteConfirmation('');
          deleteProject.reset();
        }
      }}>
        <AlertDialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            window.requestAnimationFrame(() => deleteConfirmationRef.current?.focus());
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive"><ShieldAlert /></AlertDialogMedia>
            <AlertDialogTitle>{deletionFailed ? t('Restart safe cleanup?', 'Sicheren Cleanup erneut starten?') : t('Permanently delete project?', 'Projekt endgültig löschen?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletionFailed
                ? project.deletionError ?? t('Steps already cleaned up are skipped safely.', 'Bereits bereinigte Schritte werden sicher übersprungen.')
                : t('Application, domains, deployments, logs, source data, and secrets will be removed permanently.', 'Anwendung, Domains, Deployments, Logs, Quelldaten und Secrets werden dauerhaft entfernt.')}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="delete-project-confirmation" className="max-w-full [overflow-wrap:anywhere]">{t('Enter', 'Gib zur Bestätigung')} <strong>“{project.name}”</strong> {t('to confirm', 'ein')}</Label>
            <Input
              ref={deleteConfirmationRef}
              id="delete-project-confirmation"
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={deleteProject.isPending}
              aria-invalid={deleteConfirmation.length > 0 && deleteConfirmation !== project.name || undefined}
            />
          </div>

          {deleteProject.isError && (
            <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Deletion failed', 'Löschung fehlgeschlagen')}</AlertTitle><AlertDescription>{deleteProject.error instanceof Error ? deleteProject.error.message : t('The project could not be deleted.', 'Das Projekt konnte nicht gelöscht werden.')}</AlertDescription></Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProject.isPending}>{t('Cancel', 'Abbrechen')}</AlertDialogCancel>
            <Button
              variant="danger"
              loading={deleteProject.isPending}
              disabled={deleteConfirmation !== project.name}
              onClick={() => deleteProject.mutate(deleteConfirmation)}
            >
              {!deleteProject.isPending && <Trash2 />} {t('Delete permanently', 'Endgültig löschen')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
