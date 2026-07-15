import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleX,
  Cloud,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Timer,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { Button, ErrorState, PageIntro, Skeleton } from '../components/ui';
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
import { Progress } from '../components/ui/progress';
import { Separator } from '../components/ui/separator';
import { cn } from '../lib/utils';
import type {
  ServerHealthId,
  ServerHealthStatus,
  ServerMetricsCurrent,
  ServerMetricsHistoryPoint,
  ServerMetricsRange,
  ServerMetricsResponse,
} from '../types';
import { formatRelative } from '../utils/format';
import {
  buildMetricChartPath,
  clampPercent,
  formatByteRate,
  formatBytes,
  formatMetricPercent,
  formatUptime,
  healthFromPercent,
  serverMetricsRanges,
} from '../utils/server-metrics';
import { useI18n } from '../i18n';

const healthIcons: Record<ServerHealthId, LucideIcon> = {
  collector: Activity,
  worker: Workflow,
  docker: Box,
  cpu: Cpu,
  memory: MemoryStick,
  storage: HardDrive,
  traefik: Network,
  cloudflared: Cloud,
};

function healthLabel(status: ServerHealthStatus, t: ReturnType<typeof useI18n>['t']) {
  if (status === 'healthy') return t('Healthy', 'In Ordnung');
  if (status === 'warning') return t('Warning', 'Warnung');
  if (status === 'critical') return t('Critical', 'Kritisch');
  return t('Unknown', 'Unbekannt');
}

function HealthGlyph({ status }: { status: ServerHealthStatus }) {
  if (status === 'healthy') return <CheckCircle2 className="size-4 text-success" aria-hidden="true" />;
  if (status === 'warning') return <CircleAlert className="size-4 text-warning" aria-hidden="true" />;
  if (status === 'critical') return <CircleX className="size-4 text-destructive" aria-hidden="true" />;
  return <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />;
}

function statusBadge(status: ServerMetricsResponse['status'], t: ReturnType<typeof useI18n>['t']) {
  const labels = {
    healthy: t('All systems operational', 'Alle Systeme betriebsbereit'),
    warning: t('Attention recommended', 'Prüfung empfohlen'),
    critical: t('Action required', 'Handlung erforderlich'),
    collecting: t('Collecting metrics', 'Metriken werden gesammelt'),
  } as const;
  const dot = status === 'healthy'
    ? 'bg-success'
    : status === 'warning'
      ? 'bg-warning'
      : status === 'critical'
        ? 'bg-destructive'
        : 'bg-muted-foreground';
  return (
    <Badge variant={status === 'critical' ? 'destructive' : 'outline'} className="h-8 gap-2 px-3 shadow-none">
      <span className={cn('size-1.5 rounded-full', dot, status === 'collecting' && 'status-pulse')} aria-hidden="true" />
      {labels[status]}
    </Badge>
  );
}

function ResourceMetricCard({
  label,
  value,
  detail,
  icon: Icon,
  percent,
  history,
  status,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  percent: number;
  history: number[];
  status: ServerHealthStatus;
}) {
  const bounded = clampPercent(percent);
  const path = buildMetricChartPath(history.slice(-48), 240, 52, 2);
  return (
    <Card className="min-w-0 gap-4 overflow-hidden py-5 shadow-sm">
      <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-3">
        <div className="min-w-0">
          <CardDescription className="font-medium">{label}</CardDescription>
          <CardTitle className="mt-2 truncate text-3xl tabular-nums">{value}</CardTitle>
        </div>
        <span className={cn(
          'grid size-9 place-items-center rounded-lg border bg-muted/30 text-muted-foreground',
          status === 'critical' && 'border-destructive/25 bg-destructive/5 text-destructive',
          status === 'warning' && 'border-warning/30 bg-warning/5 text-warning',
        )}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
        <Progress
          value={bounded}
          aria-label={`${label}: ${bounded.toFixed(1)}%`}
          className={cn(
            '[&_[data-slot=progress-indicator]]:bg-foreground',
            status === 'warning' && '[&_[data-slot=progress-indicator]]:bg-warning',
            status === 'critical' && '[&_[data-slot=progress-indicator]]:bg-destructive',
          )}
        />
        <div className="h-12 overflow-hidden" aria-hidden="true">
          {path ? (
            <svg viewBox="0 0 240 52" preserveAspectRatio="none" className="size-full overflow-visible">
              <path d={path} fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.55" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : <div className="h-full rounded-md bg-muted/30" />}
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceHistoryChart({ history }: { history: ServerMetricsHistoryPoint[] }) {
  const { t, locale } = useI18n();
  const width = 800;
  const height = 240;
  const padding = 20;
  const cpuPath = buildMetricChartPath(history.map((point) => point.cpuUsagePercent), width, height, padding);
  const memoryPath = buildMetricChartPath(history.map((point) => point.memoryUsagePercent), width, height, padding);
  const storagePath = buildMetricChartPath(history.map((point) => point.storageUsagePercent), width, height, padding);
  const first = history.at(0)?.sampledAt;
  const last = history.at(-1)?.sampledAt;

  if (history.length < 2) {
    return (
      <div className="grid min-h-72 place-items-center rounded-lg border border-dashed bg-muted/10 p-8 text-center">
        <div className="max-w-sm">
          <Activity className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium">{t('Building the first timeline', 'Der erste Verlauf wird aufgebaut')}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('A second sample is required before the resource history can be drawn.', 'Für den Ressourcenverlauf wird noch ein zweiter Messpunkt benötigt.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 pb-5 text-xs text-muted-foreground">
        {[
          [t('CPU', 'CPU'), 'var(--chart-1)'],
          [t('Memory', 'Arbeitsspeicher'), 'var(--chart-2)'],
          [t('Shelter storage', 'Shelter-Speicher'), 'var(--chart-3)'],
        ].map(([label, color]) => (
          <span className="flex items-center gap-2" key={label}>
            <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
            {label}
          </span>
        ))}
        <span className="ml-auto tabular-nums">{history.length} {t('samples', 'Messpunkte')}</span>
      </div>
      <div className="relative h-64 min-w-0 overflow-hidden rounded-lg border bg-muted/5 px-2 py-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="size-full"
          role="img"
          aria-label={t('CPU, memory, and Shelter storage utilization over time', 'CPU-, Arbeitsspeicher- und Shelter-Speicherauslastung im Zeitverlauf')}
        >
          {[0, 25, 50, 75, 100].map((percentage) => {
            const y = padding + (1 - percentage / 100) * (height - padding * 2);
            return <line key={percentage} x1={padding} x2={width - padding} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
          })}
          <path d={storagePath} fill="none" stroke="var(--chart-3)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={memoryPath} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={cpuPath} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="absolute top-3 left-3 text-[0.65rem] text-muted-foreground">100%</span>
        <span className="absolute bottom-3 left-3 text-[0.65rem] text-muted-foreground">0%</span>
      </div>
      <div className="mt-2 flex justify-between gap-4 text-[0.7rem] text-muted-foreground">
        <span>{formatRelative(first, locale)}</span>
        <span>{formatRelative(last, locale)}</span>
      </div>
    </div>
  );
}

function serviceStateLabel(state: string, t: ReturnType<typeof useI18n>['t']) {
  const normalized = state.toLowerCase();
  if (normalized === 'running' || normalized === 'online') return t('Running', 'Läuft');
  if (normalized === 'restarting') return t('Restarting', 'Startet neu');
  if (normalized === 'exited' || normalized === 'dead' || normalized === 'stopped' || normalized === 'offline') return t('Stopped', 'Gestoppt');
  if (normalized === 'not_configured') return t('Not configured', 'Nicht eingerichtet');
  if (normalized === 'missing') return t('Not found', 'Nicht gefunden');
  return t('Unknown', 'Unbekannt');
}

function healthCopy(id: ServerHealthId, current: ServerMetricsCurrent, sampledAt: string | null, t: ReturnType<typeof useI18n>['t'], locale: 'en' | 'de') {
  const labels: Record<ServerHealthId, string> = {
    collector: t('Metrics collector', 'Metrik-Collector'),
    worker: t('Deployment worker', 'Deployment-Worker'),
    docker: 'Docker Engine',
    cpu: 'CPU',
    memory: t('Memory', 'Arbeitsspeicher'),
    storage: t('Shelter storage', 'Shelter-Speicher'),
    traefik: 'Traefik',
    cloudflared: 'Cloudflare Tunnel',
  };
  const details: Record<ServerHealthId, string> = {
    collector: sampledAt ? t('Updated {time}', 'Aktualisiert {time}', { time: formatRelative(sampledAt, locale) }) : t('Waiting for the first sample', 'Wartet auf den ersten Messpunkt'),
    worker: t('Builds, health checks, and activation', 'Builds, Healthchecks und Aktivierung'),
    docker: current.runtime.dockerVersion ? `Docker ${current.runtime.dockerVersion}` : t('Engine information unavailable', 'Engine-Information nicht verfügbar'),
    cpu: t('{value} utilization across {cores} cores', '{value} Auslastung auf {cores} Kernen', { value: formatMetricPercent(current.cpu.usagePercent, locale), cores: current.cpu.logicalCores }),
    memory: t('{used} of {total} used', '{used} von {total} verwendet', { used: formatBytes(current.memory.usedBytes, locale), total: formatBytes(current.memory.totalBytes, locale) }),
    storage: t('{used} of {total} used by the data volume', '{used} von {total} im Datenvolume verwendet', { used: formatBytes(current.storage.usedBytes, locale), total: formatBytes(current.storage.totalBytes, locale) }),
    traefik: t('{state} · routes incoming requests', '{state} · verteilt eingehende Anfragen', { state: serviceStateLabel(current.runtime.services.traefik, t) }),
    cloudflared: current.runtime.tunnelConfigured
      ? t('{state} · outbound Zero Trust connector', '{state} · ausgehender Zero-Trust-Connector', { state: serviceStateLabel(current.runtime.services.cloudflared, t) })
      : t('Tunnel is not configured', 'Tunnel ist nicht eingerichtet'),
  };
  return { label: labels[id], detail: details[id] };
}

function ServerMetricsSkeleton() {
  return (
    <div className="grid gap-8">
      <div className="space-y-3 border-b pb-6"><Skeleton className="h-4 w-24" /><Skeleton className="h-10 w-72" /><Skeleton className="h-4 w-full max-w-xl" /></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton className="h-56" key={index} />)}</div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)]"><Skeleton className="h-[27rem]" /><Skeleton className="h-[27rem]" /></div>
    </div>
  );
}

export function ServerMetricsPage() {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<ServerMetricsRange>('1h');
  const metrics = useQuery({
    queryKey: ['server-metrics', range],
    queryFn: () => api.serverMetrics(range),
    staleTime: 5_000,
    refetchInterval: (query) => Math.max(10_000, (query.state.data?.intervalSeconds ?? 15) * 1_000),
    refetchIntervalInBackground: false,
    retry: 1,
  });

  if (metrics.isLoading) return <ServerMetricsSkeleton />;
  if (metrics.isError && !metrics.data) {
    return (
      <div className="grid gap-8">
        <PageIntro title={t('Server metrics', 'Servermetriken')} description={t('Live resource usage and Shelter services on this VPS.', 'Live-Ressourcennutzung und Shelter-Dienste auf diesem VPS.')} />
        <ErrorState
          title={t('Server metrics are unavailable', 'Servermetriken sind nicht erreichbar')}
          message={metrics.error instanceof Error ? metrics.error.message : t('The metrics endpoint could not be loaded.', 'Der Metrik-Endpunkt konnte nicht geladen werden.')}
          action={<Button onClick={() => metrics.refetch()}><RefreshCw aria-hidden="true" /> {t('Try again', 'Erneut versuchen')}</Button>}
        />
      </div>
    );
  }

  const data = metrics.data;
  if (!data) return null;
  const current = data.current;
  const healthById = new Map(data.health.map((item) => [item.id, item.status]));
  const resourceHistory = {
    cpu: data.history.map((point) => point.cpuUsagePercent),
    memory: data.history.map((point) => point.memoryUsagePercent),
    storage: data.history.map((point) => point.storageUsagePercent),
    load: current ? data.history.map((point) => (point.loadOne / Math.max(1, current.cpu.logicalCores)) * 100) : [],
  };

  return (
    <div className="flex w-full flex-col gap-8">
      <PageIntro
        eyebrow={<><Server className="size-4" aria-hidden="true" /> {t('Infrastructure', 'Infrastruktur')}</>}
        title={t('Server metrics', 'Servermetriken')}
        description={t('Live resource usage, hosted application traffic, and the services that keep this Shelter node online.', 'Live-Ressourcennutzung, Traffic der gehosteten Anwendungen und die Dienste dieses Shelter-Nodes.')}
        actions={(
          <>
            {statusBadge(data.status, t)}
            <Button variant="outline" onClick={() => metrics.refetch()} disabled={metrics.isFetching}>
              <RefreshCw className={cn(metrics.isFetching && 'animate-spin')} aria-hidden="true" />
              {t('Refresh', 'Aktualisieren')}
            </Button>
          </>
        )}
      />

      {metrics.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t('The latest refresh failed', 'Die letzte Aktualisierung ist fehlgeschlagen')}</AlertTitle>
          <AlertDescription>{t('The previous snapshot remains visible and may be outdated.', 'Der vorherige Messpunkt bleibt sichtbar und kann veraltet sein.')}</AlertDescription>
        </Alert>
      )}

      {!current ? (
        <Alert>
          <Activity className="animate-pulse" aria-hidden="true" />
          <AlertTitle>{t('The collector is warming up', 'Der Collector läuft an')}</AlertTitle>
          <AlertDescription>{t('The worker is preparing the first server snapshot. This usually takes less than a minute.', 'Der Worker bereitet den ersten Server-Messpunkt vor. Das dauert normalerweise weniger als eine Minute.')}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label={t('Current resource usage', 'Aktuelle Ressourcennutzung')}>
            <ResourceMetricCard
              label="CPU"
              value={formatMetricPercent(current.cpu.usagePercent, locale)}
              detail={t('{cores} logical cores · load {load}', '{cores} logische Kerne · Load {load}', { cores: current.cpu.logicalCores, load: current.cpu.loadAverage.one.toFixed(2) })}
              icon={Cpu}
              percent={current.cpu.usagePercent}
              history={resourceHistory.cpu}
              status={healthById.get('cpu') ?? healthFromPercent(current.cpu.usagePercent)}
            />
            <ResourceMetricCard
              label={t('Memory', 'Arbeitsspeicher')}
              value={formatMetricPercent(current.memory.usagePercent, locale)}
              detail={t('{used} of {total} used', '{used} von {total} verwendet', { used: formatBytes(current.memory.usedBytes, locale), total: formatBytes(current.memory.totalBytes, locale) })}
              icon={MemoryStick}
              percent={current.memory.usagePercent}
              history={resourceHistory.memory}
              status={healthById.get('memory') ?? healthFromPercent(current.memory.usagePercent)}
            />
            <ResourceMetricCard
              label={t('Shelter storage', 'Shelter-Speicher')}
              value={formatMetricPercent(current.storage.usagePercent, locale)}
              detail={t('{used} of {total} in the data volume', '{used} von {total} im Datenvolume', { used: formatBytes(current.storage.usedBytes, locale), total: formatBytes(current.storage.totalBytes, locale) })}
              icon={HardDrive}
              percent={current.storage.usagePercent}
              history={resourceHistory.storage}
              status={healthById.get('storage') ?? healthFromPercent(current.storage.usagePercent)}
            />
            <ResourceMetricCard
              label={t('System load', 'Systemlast')}
              value={current.cpu.loadAverage.one.toFixed(2)}
              detail={`1 / 5 / 15 min · ${current.cpu.loadAverage.one.toFixed(2)} / ${current.cpu.loadAverage.five.toFixed(2)} / ${current.cpu.loadAverage.fifteen.toFixed(2)}`}
              icon={Activity}
              percent={(current.cpu.loadAverage.one / Math.max(1, current.cpu.logicalCores)) * 100}
              history={resourceHistory.load}
              status={current.cpu.loadAverage.one >= current.cpu.logicalCores * 1.5 ? 'critical' : current.cpu.loadAverage.one >= current.cpu.logicalCores ? 'warning' : 'healthy'}
            />
          </section>

          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)]">
            <section className="min-w-0" aria-labelledby="resource-history-title">
              <Card className="h-full gap-0 py-0">
                <CardHeader className="border-b py-5 sm:px-6">
                  <CardTitle><h2 id="resource-history-title">{t('Resource history', 'Ressourcenverlauf')}</h2></CardTitle>
                  <CardDescription>{t('CPU, memory, and Shelter data-volume utilization.', 'Auslastung von CPU, Arbeitsspeicher und Shelter-Datenvolume.')}</CardDescription>
                  <CardAction>
                    <div className="flex rounded-md border bg-muted/20 p-0.5" role="group" aria-label={t('History range', 'Zeitraum')}>
                      {serverMetricsRanges.map((candidate) => (
                        <Button
                          key={candidate}
                          variant={range === candidate ? 'secondary' : 'ghost'}
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          aria-pressed={range === candidate}
                          onClick={() => setRange(candidate)}
                        >
                          {candidate}
                        </Button>
                      ))}
                    </div>
                  </CardAction>
                </CardHeader>
                <CardContent className="p-4 sm:p-6"><ResourceHistoryChart history={data.history} /></CardContent>
              </Card>
            </section>

            <section className="min-w-0" aria-labelledby="system-health-title">
              <Card className="h-full gap-0 py-0">
                <CardHeader className="border-b py-5">
                  <CardTitle><h2 id="system-health-title">{t('System health', 'Systemzustand')}</h2></CardTitle>
                  <CardDescription>{t('Collector, runtime, and routing services.', 'Collector, Runtime und Routing-Dienste.')}</CardDescription>
                </CardHeader>
                <CardContent className="divide-y p-0">
                  {data.health.map((item) => {
                    const Icon = healthIcons[item.id];
                    const copy = healthCopy(item.id, current, data.sampledAt, t, locale);
                    return (
                      <div className="flex min-w-0 items-center gap-3 px-4 py-3.5" key={item.id}>
                        <span className="grid size-8 shrink-0 place-items-center rounded-md border bg-muted/25 text-muted-foreground"><Icon className="size-3.5" aria-hidden="true" /></span>
                        <div className="min-w-0 flex-1">
                          <strong className="block truncate text-sm font-medium">{copy.label}</strong>
                          <span className="block truncate text-xs text-muted-foreground" title={copy.detail}>{copy.detail}</span>
                        </div>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium"><HealthGlyph status={item.status} /> <span className="sr-only sm:not-sr-only">{healthLabel(item.status, t)}</span></span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </section>
          </div>

          <section className="grid gap-6 lg:grid-cols-3" aria-label={t('Server details', 'Serverdetails')}>
            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-5">
                <CardTitle>{t('Hosted applications', 'Gehostete Anwendungen')}</CardTitle>
                <CardDescription>{t('Aggregate use by Shelter-managed containers.', 'Aggregierte Nutzung der von Shelter verwalteten Container.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 p-5">
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Containers running', 'Laufende Container')}</span><strong className="tabular-nums">{current.runtime.runningManagedContainers} / {current.runtime.managedContainers}</strong></div>
                <Separator />
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Application CPU', 'Anwendungs-CPU')}</span><strong className="tabular-nums">{formatMetricPercent(current.runtime.applicationCpuUsagePercent, locale)}</strong></div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Application memory', 'Anwendungs-RAM')}</span><strong className="text-right tabular-nums">{formatBytes(current.runtime.applicationMemoryUsedBytes, locale)}{current.runtime.applicationMemoryLimitBytes > 0 ? ` / ${formatBytes(current.runtime.applicationMemoryLimitBytes, locale)}` : ''}</strong></div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">Docker Engine</span><strong className="text-right text-sm">{current.runtime.dockerAvailable ? `v${current.runtime.dockerVersion ?? '—'}` : t('Unavailable', 'Nicht erreichbar')}</strong></div>
              </CardContent>
            </Card>

            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-5">
                <CardTitle>{t('Application traffic', 'Anwendungs-Traffic')}</CardTitle>
                <CardDescription>{t('Network and block I/O of managed app containers.', 'Netzwerk- und Block-I/O der verwalteten App-Container.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 p-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border bg-muted/15 p-3"><ArrowDown className="size-4 text-muted-foreground" aria-hidden="true" /><span className="mt-3 block text-xs text-muted-foreground">{t('Receive now', 'Empfang aktuell')}</span><strong className="mt-1 block text-lg tabular-nums">{formatByteRate(current.runtime.applicationNetworkReceiveBytesPerSecond, locale)}</strong></div>
                  <div className="rounded-lg border bg-muted/15 p-3"><ArrowUp className="size-4 text-muted-foreground" aria-hidden="true" /><span className="mt-3 block text-xs text-muted-foreground">{t('Send now', 'Versand aktuell')}</span><strong className="mt-1 block text-lg tabular-nums">{formatByteRate(current.runtime.applicationNetworkTransmitBytesPerSecond, locale)}</strong></div>
                </div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Network total', 'Netzwerk gesamt')}</span><strong className="text-right text-sm tabular-nums">↓ {formatBytes(current.runtime.applicationNetworkReceivedBytes, locale)} · ↑ {formatBytes(current.runtime.applicationNetworkTransmittedBytes, locale)}</strong></div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">Block I/O</span><strong className="text-right text-sm tabular-nums">↓ {formatBytes(current.runtime.applicationBlockReadBytes, locale)} · ↑ {formatBytes(current.runtime.applicationBlockWriteBytes, locale)}</strong></div>
              </CardContent>
            </Card>

            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-5">
                <CardTitle>{t('Deployment activity', 'Deployment-Aktivität')}</CardTitle>
                <CardDescription>{t('Projects and builds across the last 24 hours.', 'Projekte und Builds der letzten 24 Stunden.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 p-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border bg-muted/15 p-3"><span className="text-xs text-muted-foreground">{t('Live projects', 'Live-Projekte')}</span><strong className="mt-2 block text-2xl tabular-nums">{data.activity.liveProjects}<span className="text-sm font-normal text-muted-foreground"> / {data.activity.projects}</span></strong></div>
                  <div className="rounded-lg border bg-muted/15 p-3"><span className="text-xs text-muted-foreground">Domains</span><strong className="mt-2 block text-2xl tabular-nums">{data.activity.domains}</strong></div>
                </div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Queued / active', 'Wartend / aktiv')}</span><strong className="tabular-nums">{data.activity.deployments.queued} / {data.activity.deployments.active}</strong></div>
                <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t('Ready / failed (24h)', 'Bereit / fehlgeschlagen (24h)')}</span><strong className="tabular-nums">{data.activity.deployments.readyLast24Hours} / {data.activity.deployments.failedLast24Hours}</strong></div>
              </CardContent>
            </Card>
          </section>

          <section aria-labelledby="node-details-title">
            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-5 sm:px-6">
                <CardTitle><h2 id="node-details-title">{t('Node details', 'Node-Details')}</h2></CardTitle>
                <CardDescription>{t('Identity, operating system, uptime, and maintenance context.', 'Identität, Betriebssystem, Laufzeit und Wartungskontext.')}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-x-8 gap-y-5 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-4">
                {[
                  [t('Node', 'Node'), current.host.name],
                  [t('Operating system', 'Betriebssystem'), current.host.operatingSystem],
                  [t('Kernel / architecture', 'Kernel / Architektur'), `${current.host.kernel} · ${current.host.architecture}`],
                  [t('Uptime', 'Laufzeit'), formatUptime(current.host.uptimeSeconds, locale)],
                  [t('Available memory', 'Verfügbarer RAM'), formatBytes(current.memory.availableBytes, locale)],
                  [t('Swap used', 'Verwendeter Swap'), current.memory.swapTotalBytes > 0 ? `${formatBytes(current.memory.swapUsedBytes, locale)} / ${formatBytes(current.memory.swapTotalBytes, locale)}` : t('No swap configured', 'Kein Swap eingerichtet')],
                  [t('Storage available', 'Speicher verfügbar'), formatBytes(current.storage.availableBytes, locale)],
                  [t('Last storage cleanup', 'Letzte Speicherbereinigung'), current.runtime.lastStorageMaintenanceAt ? formatRelative(current.runtime.lastStorageMaintenanceAt, locale) : t('Not recorded yet', 'Noch nicht erfasst')],
                ].map(([label, value]) => (
                  <div className="min-w-0" key={label}>
                    <span className="block text-xs text-muted-foreground">{label}</span>
                    <strong className="mt-1 block truncate text-sm font-medium" title={value}>{value}</strong>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="size-3.5" aria-hidden="true" />
            {data.sampledAt
              ? t('Last sample {time}; automatic refresh every {seconds} seconds.', 'Letzter Messpunkt {time}; automatische Aktualisierung alle {seconds} Sekunden.', { time: formatRelative(data.sampledAt, locale), seconds: data.intervalSeconds })
              : t('Waiting for the first sample.', 'Wartet auf den ersten Messpunkt.')}
          </p>
        </>
      )}
    </div>
  );
}
