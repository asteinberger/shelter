import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Box,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Cpu,
  Download,
  HardDrive,
  HeartPulse,
  MemoryStick,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamRuntimeLogs } from '../api/client';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import type {
  Project,
  ProjectObservabilityCurrent,
  ProjectObservabilityHistoryPoint,
  ProjectObservabilityRange,
  ProjectObservabilityResponse,
  ProjectObservabilityWarning,
  RuntimeLog,
} from '../types';
import { formatDate, formatRelative } from '../utils/format';
import {
  buildMetricChartPath,
  clampPercent,
  formatByteRate,
  formatBytes,
  formatMetricPercent,
  formatUptime,
} from '../utils/server-metrics';
import { Button, ErrorState, Skeleton } from './ui';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './ui/empty';
import { Input } from './ui/input';
import { Progress } from './ui/progress';

const ranges: ProjectObservabilityRange[] = ['15m', '1h', '6h', '24h', '48h'];
const LOG_VIEW_LIMIT = 500;

function statusCopy(status: ProjectObservabilityResponse['status'], t: ReturnType<typeof useI18n>['t']) {
  if (status === 'healthy') return { label: t('Runtime healthy', 'Laufzeit in Ordnung'), dot: 'bg-success' };
  if (status === 'warning') return { label: t('Attention recommended', 'Prüfung empfohlen'), dot: 'bg-warning' };
  if (status === 'critical') return { label: t('Action required', 'Handlung erforderlich'), dot: 'bg-destructive' };
  if (status === 'stale') return { label: t('Collector delayed', 'Collector verzögert'), dot: 'bg-warning' };
  return { label: t('Collecting first sample', 'Erster Messpunkt wird gesammelt'), dot: 'bg-muted-foreground' };
}

function runtimeLabel(status: ProjectObservabilityCurrent['runtime']['status'], t: ReturnType<typeof useI18n>['t']) {
  const labels: Record<ProjectObservabilityCurrent['runtime']['status'], string> = {
    created: t('Created', 'Erstellt'),
    running: t('Running', 'Läuft'),
    paused: t('Paused', 'Pausiert'),
    restarting: t('Restarting', 'Startet neu'),
    removing: t('Stopping', 'Wird gestoppt'),
    exited: t('Stopped', 'Gestoppt'),
    dead: t('Failed', 'Ausgefallen'),
    missing: t('Not found', 'Nicht gefunden'),
    unknown: t('Unknown', 'Unbekannt'),
  };
  return labels[status];
}

function healthLabel(health: ProjectObservabilityCurrent['runtime']['health'], t: ReturnType<typeof useI18n>['t']) {
  if (health === 'healthy') return t('Health check passes', 'Healthcheck erfolgreich');
  if (health === 'unhealthy') return t('Health check fails', 'Healthcheck fehlgeschlagen');
  if (health === 'starting') return t('Health check starts', 'Healthcheck startet');
  if (health === 'none') return t('No container health check', 'Kein Container-Healthcheck');
  return t('Health unknown', 'Health unbekannt');
}

export function projectWarningCopy(
  warning: ProjectObservabilityWarning,
  t: ReturnType<typeof useI18n>['t'],
) {
  const roundedValue = Math.round(warning.value ?? 0);
  if (warning.id === 'runtime') return {
    title: t('The active runtime is not available', 'Die aktive Laufzeit ist nicht verfügbar'),
    description: t('Check the runtime logs and deploy the latest version again. Public traffic may currently fail.', 'Prüfe die Laufzeit-Logs und deploye den aktuellen Stand erneut. Öffentliche Aufrufe können gerade fehlschlagen.'),
    action: 'logs' as const,
  };
  if (warning.id === 'health') return {
    title: t('The application health check is failing', 'Der Anwendungs-Healthcheck schlägt fehl'),
    description: t('Inspect the latest application output and verify the configured health-check path.', 'Prüfe die aktuelle Anwendungsausgabe und den eingestellten Healthcheck-Pfad.'),
    action: 'logs' as const,
  };
  if (warning.id === 'oom') return {
    title: t('The container was terminated for using too much memory', 'Der Container wurde wegen zu hoher Speichernutzung beendet'),
    description: t('Look for a memory leak or raise the project memory limit before the next deployment.', 'Suche nach einem Memory-Leak oder erhöhe vor dem nächsten Deployment das Arbeitsspeicher-Limit.'),
    action: 'settings' as const,
  };
  if (warning.id === 'restarts') return {
    title: t('{count} runtime restarts detected', '{count} Laufzeit-Neustarts erkannt', { count: roundedValue }),
    description: t('Review the runtime logs around startup and verify that the process stays in the foreground.', 'Prüfe die Laufzeit-Logs rund um den Start und ob der Prozess dauerhaft im Vordergrund läuft.'),
    action: 'logs' as const,
  };
  if (warning.id === 'cpu') return {
    title: t('CPU is close to the configured limit', 'CPU liegt nahe am eingestellten Limit'),
    description: t('{value}% of the project CPU capacity is currently used. Optimize sustained work or adjust the limit.', 'Aktuell werden {value}% der Projekt-CPU-Kapazität genutzt. Optimiere dauerhafte Last oder passe das Limit an.', { value: roundedValue }),
    action: 'settings' as const,
  };
  return {
    title: t('Memory is close to the configured limit', 'Arbeitsspeicher liegt nahe am eingestellten Limit'),
    description: t('{value}% of the project memory is currently used. Inspect the process before it is OOM-killed.', 'Aktuell werden {value}% des Projekt-Arbeitsspeichers genutzt. Prüfe den Prozess, bevor er wegen OOM beendet wird.', { value: roundedValue }),
    action: 'settings' as const,
  };
}

function HealthGlyph({ status }: { status: ProjectObservabilityResponse['status'] }) {
  if (status === 'healthy') return <CircleCheck className="size-4 text-success" aria-hidden="true" />;
  if (status === 'critical') return <CircleX className="size-4 text-destructive" aria-hidden="true" />;
  if (status === 'warning' || status === 'stale') return <CircleAlert className="size-4 text-warning" aria-hidden="true" />;
  return <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />;
}

function MetricCard({
  title,
  value,
  detail,
  icon: Icon,
  progress,
  history,
  tone = 'default',
}: {
  title: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  progress?: number;
  history: number[];
  tone?: 'default' | 'warning' | 'critical';
}) {
  const path = buildMetricChartPath(history.slice(-48), 240, 48, 3);
  return (
    <Card className="min-w-0 gap-4 overflow-hidden py-5 shadow-sm">
      <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-3">
        <div className="min-w-0">
          <CardDescription className="font-medium">{title}</CardDescription>
          <CardTitle className="mt-2 truncate text-2xl tabular-nums">{value}</CardTitle>
        </div>
        <span className={cn(
          'grid size-9 place-items-center rounded-lg border bg-muted/30 text-muted-foreground',
          tone === 'warning' && 'border-warning/30 bg-warning/5 text-warning',
          tone === 'critical' && 'border-destructive/30 bg-destructive/5 text-destructive',
        )}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
        {progress !== undefined && (
          <Progress
            value={clampPercent(progress)}
            className={cn(
              '[&_[data-slot=progress-indicator]]:bg-foreground',
              tone === 'warning' && '[&_[data-slot=progress-indicator]]:bg-warning',
              tone === 'critical' && '[&_[data-slot=progress-indicator]]:bg-destructive',
            )}
          />
        )}
        <div className="h-11" aria-hidden="true">
          {path ? (
            <svg viewBox="0 0 240 48" preserveAspectRatio="none" className="size-full overflow-visible">
              <path d={path} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.52" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : <div className="h-full rounded-md bg-muted/25" />}
        </div>
      </CardContent>
    </Card>
  );
}

function normalized(values: number[]) {
  const maximum = Math.max(1, ...values);
  return values.map((value) => value / maximum * 100);
}

export function ProjectHistoryChart({
  history,
  cpuLimitCores,
}: {
  history: ProjectObservabilityHistoryPoint[];
  cpuLimitCores: number;
}) {
  const { t, locale } = useI18n();
  if (history.length < 2) {
    return (
      <div className="grid min-h-64 place-items-center rounded-lg border border-dashed bg-muted/10 p-8 text-center">
        <div className="max-w-sm">
          <Activity className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">{t('Building the first project timeline', 'Der erste Projektverlauf wird aufgebaut')}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('Two worker samples are required before a trend can be drawn.', 'Für einen Verlauf werden zwei Messpunkte des Workers benötigt.')}</p>
        </div>
      </div>
    );
  }
  const width = 800;
  const height = 220;
  const padding = 18;
  const cpuCapacity = Math.max(0.1, cpuLimitCores) * 100;
  const cpuPath = buildMetricChartPath(history.map((point) => point.cpuUsagePercent / cpuCapacity * 100), width, height, padding);
  const memoryPath = buildMetricChartPath(history.map((point) => point.memoryUsagePercent), width, height, padding);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--chart-1)]" />{t('CPU limit utilization', 'CPU-Limit-Auslastung')}</span>
        <span className="flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--chart-2)]" />{t('Memory limit utilization', 'RAM-Limit-Auslastung')}</span>
        <span className="ml-auto tabular-nums">{history.length} {t('samples', 'Messpunkte')}</span>
      </div>
      <div className="relative h-60 overflow-hidden rounded-lg border bg-muted/5 px-2 py-3">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="size-full" role="img" aria-label={t('CPU and memory utilization over time', 'CPU- und Arbeitsspeicherauslastung im Zeitverlauf')}>
          {[0, 25, 50, 75, 100].map((value) => {
            const y = padding + (1 - value / 100) * (height - padding * 2);
            return <line key={value} x1={padding} x2={width - padding} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
          })}
          <path d={memoryPath} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={cpuPath} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="absolute top-3 left-3 text-[0.65rem] text-muted-foreground">100%</span>
        <span className="absolute bottom-3 left-3 text-[0.65rem] text-muted-foreground">0%</span>
      </div>
      <div className="mt-2 flex justify-between gap-4 text-[0.7rem] text-muted-foreground">
        <span>{formatRelative(history.at(0)?.sampledAt, locale)}</span>
        <span>{formatRelative(history.at(-1)?.sampledAt, locale)}</span>
      </div>
    </div>
  );
}

function ProjectObservabilitySkeleton() {
  return (
    <div className="grid gap-5">
      <Skeleton className="h-20" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton className="h-52" key={index} />)}</div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.6fr)]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
      <Skeleton className="h-[30rem]" />
    </div>
  );
}

function mergeLogs(current: RuntimeLog[], incoming: RuntimeLog[]) {
  const byId = new Map(current.map((log) => [log.id, log]));
  for (const log of incoming) byId.set(log.id, log);
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-LOG_VIEW_LIMIT);
}

export function ProjectObservabilityTab({
  project,
  onOpenSettings,
}: {
  project: Project;
  onOpenSettings: () => void;
}) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<ProjectObservabilityRange>('1h');
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [paused, setPaused] = useState(false);
  const [streamDelayed, setStreamDelayed] = useState(false);
  const [search, setSearch] = useState('');
  const [streamFilter, setStreamFilter] = useState<'all' | 'stdout' | 'stderr'>('all');
  const [follow, setFollow] = useState(true);
  const logViewport = useRef<HTMLDivElement>(null);
  const latestLogId = useRef(0);

  const metrics = useQuery({
    queryKey: ['project-observability', project.id, range],
    queryFn: () => api.projectObservability(project.id, range),
    staleTime: 5_000,
    refetchInterval: (query) => Math.max(10_000, (query.state.data?.intervalSeconds ?? 15) * 1_000),
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const runtimeLogs = useQuery({
    queryKey: ['project-runtime-logs', project.id, project.activeDeploymentId],
    queryFn: () => api.runtimeLogs(project.id, 0, LOG_VIEW_LIMIT),
    staleTime: 5_000,
    retry: 1,
  });
  const refetchRuntimeLogs = runtimeLogs.refetch;
  const refetchMetrics = metrics.refetch;

  useEffect(() => {
    if (!runtimeLogs.data) return;
    setLogs(runtimeLogs.data.logs);
    latestLogId.current = runtimeLogs.data.logs.at(-1)?.id ?? 0;
  }, [runtimeLogs.data, runtimeLogs.dataUpdatedAt]);

  useEffect(() => {
    if (!runtimeLogs.data || paused) return undefined;
    setStreamDelayed(false);
    return streamRuntimeLogs(project.id, {
      onLog(log) {
        latestLogId.current = Math.max(latestLogId.current, log.id);
        setLogs((current) => mergeLogs(current, [log]));
        setStreamDelayed(false);
      },
      onDeployment() {
        setLogs([]);
        latestLogId.current = 0;
        void refetchRuntimeLogs();
        void refetchMetrics();
      },
      onOpen() {
        setStreamDelayed(false);
      },
      onError() {
        setStreamDelayed(true);
      },
    }, latestLogId.current);
  }, [paused, project.id, refetchMetrics, refetchRuntimeLogs, runtimeLogs.dataUpdatedAt]);

  const visibleLogs = useMemo(() => {
    const term = search.trim().toLocaleLowerCase(locale === 'de' ? 'de-DE' : 'en-US');
    return logs.filter((log) => (
      (streamFilter === 'all' || log.stream === streamFilter)
      && (!term || log.message.toLocaleLowerCase(locale === 'de' ? 'de-DE' : 'en-US').includes(term))
    ));
  }, [locale, logs, search, streamFilter]);

  useEffect(() => {
    if (!follow || paused) return;
    const viewport = logViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [follow, paused, visibleLogs.length]);

  const downloadLogs = useCallback(() => {
    const text = visibleLogs.map((log) => `${log.timestamp} ${log.stream.padEnd(6)} ${log.message}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.slug ?? project.id}-runtime.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [project.id, project.slug, visibleLogs]);

  if (metrics.isLoading && !metrics.data) return <ProjectObservabilitySkeleton />;
  if (metrics.isError && !metrics.data) {
    return (
      <ErrorState
        title={t('Project observability is unavailable', 'Projekt-Observability ist nicht erreichbar')}
        message={metrics.error instanceof Error ? metrics.error.message : t('The metrics endpoint could not be loaded.', 'Der Metrik-Endpunkt konnte nicht geladen werden.')}
        action={<Button onClick={() => metrics.refetch()}><RefreshCw /> {t('Try again', 'Erneut versuchen')}</Button>}
      />
    );
  }
  const data = metrics.data;
  if (!data) return null;
  const current = data.current;
  const status = statusCopy(data.status, t);
  const cpuHistory = current
    ? data.history.map((point) => point.cpuUsagePercent / (current.cpu.limitCores * 100) * 100)
    : [];
  const memoryHistory = data.history.map((point) => point.memoryUsagePercent);
  const receiveHistory = normalized(data.history.map((point) => point.networkReceiveBytesPerSecond));
  const blockHistory = normalized(data.history.map((point) => point.blockReadBytes + point.blockWriteBytes));
  const warningIds = new Set(data.warnings.map((warning) => warning.id));
  const cpuTone = warningIds.has('cpu') ? (data.warnings.find((warning) => warning.id === 'cpu')?.severity ?? 'warning') : 'default';
  const memoryTone = warningIds.has('memory') || warningIds.has('oom')
    ? (data.warnings.some((warning) => ['memory', 'oom'].includes(warning.id) && warning.severity === 'critical') ? 'critical' : 'warning')
    : 'default';

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border bg-muted/30"><HealthGlyph status={data.status} /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm font-medium">{status.label}</strong>
              <span className={cn('size-1.5 rounded-full', status.dot, data.status === 'collecting' && 'status-pulse')} aria-hidden="true" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.sampledAt
                ? t('Worker sample {time} · about every {seconds}s', 'Worker-Messpunkt {time} · etwa alle {seconds}s', { time: formatRelative(data.sampledAt, locale), seconds: data.intervalSeconds })
                : t('The worker needs up to two collection intervals for the first complete sample.', 'Der Worker benötigt bis zu zwei Erfassungsintervalle für den ersten vollständigen Messpunkt.')}
            </p>
          </div>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border bg-muted/20 p-1" role="group" aria-label={t('Metrics time range', 'Zeitraum der Metriken')}>
          {ranges.map((candidate) => (
            <Button key={candidate} size="sm" variant={range === candidate ? 'secondary' : 'ghost'} className="h-7 min-w-10 px-2 text-xs" onClick={() => setRange(candidate)}>{candidate}</Button>
          ))}
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="grid gap-3" aria-label={t('Current runtime warnings', 'Aktuelle Laufzeitwarnungen')}>
          {data.warnings.map((warning) => {
            const copy = projectWarningCopy(warning, t);
            return (
              <Alert key={warning.id} variant={warning.severity === 'critical' ? 'destructive' : 'default'} className={warning.severity === 'warning' ? 'border-warning/35 bg-warning/5' : undefined}>
                <AlertTriangle className={warning.severity === 'warning' ? 'text-warning' : undefined} />
                <AlertTitle>{copy.title}</AlertTitle>
                <AlertDescription>{copy.description}</AlertDescription>
                <Button variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={() => {
                  if (copy.action === 'settings') onOpenSettings();
                  else logViewport.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}>
                  {copy.action === 'settings' ? t('Open project settings', 'Projekteinstellungen öffnen') : t('Inspect runtime logs', 'Laufzeit-Logs prüfen')}
                </Button>
              </Alert>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={t('CPU capacity', 'CPU-Kapazität')}
          value={current ? formatMetricPercent(current.cpu.limitUsagePercent, locale) : '—'}
          detail={current ? t('{usage} raw · {limit} CPU limit', '{usage} roh · {limit} CPU-Limit', { usage: formatMetricPercent(current.cpu.usagePercent, locale), limit: current.cpu.limitCores }) : t('Waiting for runtime', 'Wartet auf Laufzeit')}
          icon={Cpu}
          progress={current?.cpu.limitUsagePercent}
          history={cpuHistory}
          tone={cpuTone}
        />
        <MetricCard
          title={t('Memory', 'Arbeitsspeicher')}
          value={current ? formatBytes(current.memory.usedBytes, locale) : '—'}
          detail={current ? t('{percent} of {limit}', '{percent} von {limit}', { percent: formatMetricPercent(current.memory.usagePercent, locale), limit: formatBytes(current.memory.limitBytes, locale) }) : t('Waiting for runtime', 'Wartet auf Laufzeit')}
          icon={MemoryStick}
          progress={current?.memory.usagePercent}
          history={memoryHistory}
          tone={memoryTone}
        />
        <MetricCard
          title={t('Network throughput', 'Netzwerkdurchsatz')}
          value={current ? formatByteRate(current.network.receiveBytesPerSecond + current.network.transmitBytesPerSecond, locale) : '—'}
          detail={current ? `↓ ${formatByteRate(current.network.receiveBytesPerSecond, locale)} · ↑ ${formatByteRate(current.network.transmitBytesPerSecond, locale)}` : t('Waiting for runtime', 'Wartet auf Laufzeit')}
          icon={Activity}
          history={receiveHistory}
        />
        <MetricCard
          title={t('Block I/O', 'Block-I/O')}
          value={current ? formatBytes(current.blockIo.readBytes + current.blockIo.writeBytes, locale) : '—'}
          detail={current ? `${t('Read', 'Lesen')} ${formatBytes(current.blockIo.readBytes, locale)} · ${t('Write', 'Schreiben')} ${formatBytes(current.blockIo.writeBytes, locale)}` : t('Waiting for runtime', 'Wartet auf Laufzeit')}
          icon={HardDrive}
          history={blockHistory}
        />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.55fr)]">
        <Card className="min-w-0">
          <CardHeader className="border-b">
            <CardTitle>{t('Resource history', 'Ressourcenverlauf')}</CardTitle>
            <CardDescription>{t('CPU and memory relative to this project’s configured limits.', 'CPU und Arbeitsspeicher relativ zu den eingestellten Projekt-Limits.')}</CardDescription>
          </CardHeader>
          <CardContent><ProjectHistoryChart history={data.history} cpuLimitCores={current?.cpu.limitCores ?? Number(project.cpuLimit ?? 1)} /></CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t('Runtime state', 'Laufzeitstatus')}</CardTitle>
            <CardDescription>{t('State of the active production container.', 'Status des aktiven Produktionscontainers.')}</CardDescription>
            <CardAction><Box className="size-4 text-muted-foreground" /></CardAction>
          </CardHeader>
          <CardContent className="grid gap-1 p-0">
            {current ? [
              { icon: HeartPulse, label: t('Container', 'Container'), value: runtimeLabel(current.runtime.status, t) },
              { icon: Activity, label: 'Health', value: healthLabel(current.runtime.health, t) },
              { icon: Timer, label: 'Uptime', value: formatUptime(current.runtime.uptimeSeconds, locale) },
              { icon: RefreshCw, label: t('Restarts', 'Neustarts'), value: String(current.runtime.restartCount) },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-b-0">
                <span className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5" />{label}</span>
                <strong className="text-right text-xs font-medium tabular-nums">{value}</strong>
              </div>
            )) : (
              <Empty className="min-h-64 border-0">
                <EmptyHeader><EmptyMedia variant="icon"><Box /></EmptyMedia><EmptyTitle>{t('No active runtime', 'Keine aktive Laufzeit')}</EmptyTitle><EmptyDescription>{t('Deploy this project to start collecting container data.', 'Deploye dieses Projekt, um Containerdaten zu erfassen.')}</EmptyDescription></EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0 overflow-hidden" id="runtime-logs">
        <CardHeader className="border-b">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{t('Runtime logs', 'Laufzeit-Logs')}</CardTitle>
              <Badge variant="outline" className="gap-1.5 font-normal">
                <span className={cn('size-1.5 rounded-full', paused ? 'bg-muted-foreground' : streamDelayed ? 'bg-warning' : 'bg-success')} />
                {paused ? t('Paused', 'Pausiert') : streamDelayed ? t('Reconnecting', 'Verbindung wird erneuert') : t('Near-live', 'Nahezu live')}
              </Badge>
            </div>
            <CardDescription className="mt-1.5">{t(
              'Output of the active production container. Build and deployment logs remain in Deployments.',
              'Ausgabe des aktiven Produktionscontainers. Build- und Deployment-Logs bleiben unter Deployments.',
            )}</CardDescription>
          </div>
          <CardAction className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPaused((value) => !value)}>{paused ? <Play /> : <Pause />}{paused ? t('Resume', 'Fortsetzen') : t('Pause', 'Pausieren')}</Button>
            <Button variant="outline" size="sm" onClick={downloadLogs} disabled={visibleLogs.length === 0}><Download /> <span className="hidden sm:inline">{t('Download', 'Laden')}</span></Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 bg-muted/10 p-3 sm:p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Search runtime output…', 'Laufzeitausgabe durchsuchen …')} className="pl-9" />
            </div>
            <div className="flex gap-1 overflow-x-auto rounded-lg border bg-background p-1">
              {(['all', 'stdout', 'stderr'] as const).map((stream) => (
                <Button key={stream} variant={streamFilter === stream ? 'secondary' : 'ghost'} size="sm" className="h-7 px-2 text-xs" onClick={() => setStreamFilter(stream)}>{stream === 'all' ? t('All streams', 'Alle Streams') : stream}</Button>
              ))}
            </div>
            <Button variant={follow ? 'secondary' : 'outline'} size="sm" onClick={() => setFollow((value) => !value)}>{follow ? <ArrowDown /> : <Pause />}{t('Follow', 'Folgen')}</Button>
          </div>

          <div ref={logViewport} className="h-[26rem] overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-[0.72rem] leading-5 text-zinc-200 shadow-inner" aria-label={t('Active runtime output', 'Ausgabe der aktiven Laufzeit')}>
            {runtimeLogs.isLoading && logs.length === 0 ? (
              <div className="grid h-full place-items-center text-zinc-500"><RefreshCw className="size-4 animate-spin" /></div>
            ) : visibleLogs.length === 0 ? (
              <div className="grid h-full place-items-center p-8 text-center text-zinc-500">
                <div><TerminalSquare className="mx-auto size-5" /><p className="mt-3">{search || streamFilter !== 'all' ? t('No log lines match this filter.', 'Keine Logzeile passt zu diesem Filter.') : t('No runtime output has been collected yet.', 'Es wurde noch keine Laufzeitausgabe erfasst.')}</p></div>
              </div>
            ) : visibleLogs.map((log) => (
              <div key={log.id} className="grid min-w-max grid-cols-[7rem_3.5rem_minmax(0,1fr)] gap-3 border-b border-white/5 py-0.5 last:border-0">
                <time className="text-zinc-600" dateTime={log.timestamp} title={formatDate(log.timestamp, locale)}>{new Date(log.timestamp).toLocaleTimeString(locale === 'de' ? 'de-DE' : 'en-US', { hour12: false })}</time>
                <span className={cn(log.stream === 'stderr' ? 'text-amber-400' : 'text-emerald-400/80')}>{log.stream}</span>
                <span className="whitespace-pre-wrap break-all">{log.message}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 text-[0.7rem] leading-relaxed text-muted-foreground sm:flex-row sm:items-start sm:justify-between">
            <p>{t(
              'Admin-only · active deployment only · worker refresh about every {seconds}s · {hours}h retention · up to 5,000 lines per project; this view keeps the latest 500.',
              'Nur für Admins · nur aktives Deployment · Worker-Aktualisierung etwa alle {seconds}s · {hours} Std. Aufbewahrung · bis zu 5.000 Zeilen pro Projekt; diese Ansicht hält die letzten 500.',
              { seconds: data.intervalSeconds, hours: data.retentionHours },
            )}</p>
            <p className="max-w-xl sm:text-right">{t(
              'Application logs can still contain sensitive data. Shelter redacts exact configured environment values, but cannot recognize every derived or reformatted secret.',
              'Anwendungs-Logs können weiterhin sensible Daten enthalten. Shelter schwärzt exakt konfigurierte Umgebungswerte, kann aber nicht jedes abgeleitete oder umformatierte Secret erkennen.',
            )}</p>
          </div>
          {runtimeLogs.isError && (
            <Alert variant="destructive"><AlertTriangle /><AlertTitle>{t('Runtime logs could not be loaded', 'Laufzeit-Logs konnten nicht geladen werden')}</AlertTitle><AlertDescription>{runtimeLogs.error instanceof Error ? runtimeLogs.error.message : t('Please try again.', 'Bitte versuche es erneut.')}</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
