import { useQuery } from '@tanstack/react-query';
import {
  Copy,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  WrapText,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, streamDeploymentLogs } from '../api/client';
import type { Deployment } from '../types';
import { activeDeploymentStates } from '../utils/deployment';
import { cn } from '@/lib/utils';
import { Button } from './ui';
import { Badge } from './ui/badge';
import {
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useI18n } from '@/i18n';

export function DeploymentLogsPanel({ deployment }: { deployment?: Deployment }) {
  const { t } = useI18n();
  const [streamedLines, setStreamedLines] = useState<Array<{ id?: number; line: string }>>([]);
  const [following, setFollowing] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamCursor = useRef(0);
  const active = Boolean(deployment && activeDeploymentStates.has(deployment.status));
  const logs = useQuery({
    queryKey: ['deployment-logs', deployment?.id],
    queryFn: () => api.deploymentLogs(deployment!.id),
    enabled: Boolean(deployment?.id),
    refetchInterval: false,
  });

  useEffect(() => {
    setStreamedLines([]);
    streamCursor.current = 0;
    setFollowing(true);
    setStreamError(false);
    setStreamRevision(0);
  }, [deployment?.id]);

  useEffect(() => {
    if (logs.isSuccess) streamCursor.current = Math.max(streamCursor.current, logs.data.lastId);
  }, [logs.data?.lastId, logs.isSuccess]);

  useEffect(() => {
    if (!deployment?.id || !active || !logs.isSuccess) return undefined;
    setStreamError(false);
    return streamDeploymentLogs(
      deployment.id,
      (line, logId) => {
        if (logId && logId <= streamCursor.current) return;
        if (logId) streamCursor.current = logId;
        setStreamedLines((current) => [...current.slice(-499), { id: logId, line }]);
      },
      () => setStreamError(true),
      streamCursor.current,
    );
  }, [deployment?.id, active, logs.isSuccess, logs.data?.lastId, streamRevision]);

  useEffect(() => {
    if (following && viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
  }, [following, streamedLines.length, logs.data?.content]);

  const content = [
    logs.data?.content,
    ...streamedLines
      .filter((entry) => !entry.id || entry.id > (logs.data?.lastId ?? 0))
      .map((entry) => entry.line),
  ].filter(Boolean).join('\n');

  async function copyLogs() {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t('Build logs copied', 'Build-Logs kopiert'));
    } catch {
      toast.error(t('Build logs could not be copied', 'Build-Logs konnten nicht kopiert werden'));
    }
  }

  return (
    <Card className="w-full min-w-0 max-w-full gap-0 overflow-hidden border-black/20 bg-terminal py-0 text-terminal-foreground">
      <CardHeader className="flex min-h-13 grid-cols-[1fr_auto] items-center gap-3 border-b border-white/10 px-4 py-3">
        <CardTitle className="truncate font-mono text-xs text-white/80">{t('Build output', 'Build-Ausgabe')}</CardTitle>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('text-white/55 hover:bg-white/10 hover:text-white', wrapLines && 'bg-white/10 text-white')}
                onClick={() => setWrapLines((value) => !value)}
                aria-label={wrapLines ? t('Disable line wrapping', 'Zeilenumbruch deaktivieren') : t('Enable line wrapping', 'Zeilenumbruch aktivieren')}
              >
                <WrapText aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{wrapLines ? t('Line wrapping off', 'Zeilenumbruch aus') : t('Wrap lines', 'Zeilen umbrechen')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-white/55 hover:bg-white/10 hover:text-white"
                onClick={copyLogs}
                disabled={!content}
                aria-label={t('Copy logs', 'Logs kopieren')}
              >
                <Copy aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Copy logs', 'Logs kopieren')}</TooltipContent>
          </Tooltip>
          <Badge
            variant="outline"
            className={cn(
              'ml-1 border-white/15 bg-white/5 font-mono text-[0.62rem] text-white/65',
              active && 'border-terminal-foreground/25 bg-terminal-foreground/10 text-terminal-foreground',
            )}
          >
            <span className={cn('size-1.5 rounded-full bg-current', active && 'status-pulse')} aria-hidden="true" />
            {active ? 'LIVE' : t('ARCHIVE', 'ARCHIV')}
          </Badge>
        </div>
      </CardHeader>

      <div
        ref={viewportRef}
        className="terminal-scrollbar relative h-[min(32rem,55svh)] min-h-80 w-full min-w-0 max-w-full overflow-x-auto overflow-y-auto px-4 py-4 font-mono text-xs leading-6 text-white/72"
        aria-label={t('Deployment logs', 'Deployment-Logs')}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          setFollowing(atBottom);
        }}
      >
        {!deployment ? (
          <p className="text-white/45">{t('No logs are available for this deployment.', 'Für dieses Deployment sind keine Logs verfügbar.')}</p>
        ) : logs.isLoading ? (
          <p className="flex items-center gap-2 text-white/45"><LoaderCircle className="size-3.5 animate-spin" /> {t('Loading logs …', 'Logs werden geladen …')}</p>
        ) : logs.isError ? (
          <div className="flex flex-col items-start gap-3 text-red-300">
            <span>{logs.error instanceof Error ? logs.error.message : t('Logs could not be loaded.', 'Logs konnten nicht geladen werden.')}</span>
            <Button variant="outline" size="sm" className="border-white/15 bg-white/5 text-white hover:bg-white/10" onClick={() => logs.refetch()}>
              <RefreshCw /> {t('Load again', 'Erneut laden')}
            </Button>
          </div>
        ) : content ? (
          <pre className={cn('m-0 min-w-max font-inherit', wrapLines && 'min-w-0 whitespace-pre-wrap break-words')}>{content}</pre>
        ) : (
          <p className="text-white/45">{t('No output yet.', 'Noch keine Ausgabe.')}</p>
        )}

        {!following && content && (
          <Button
            variant="outline"
            size="sm"
            className="sticky bottom-2 left-1/2 -translate-x-1/2 border-white/15 bg-terminal/95 text-white shadow-lg hover:bg-white/10"
            onClick={() => setFollowing(true)}
          >
            <Play /> {t('Follow live', 'Live folgen')}
          </Button>
        )}
      </div>

      <CardFooter className="flex min-h-10 flex-wrap justify-between gap-2 border-t border-white/10 bg-white/3 px-4 py-2 font-mono text-[0.62rem] tracking-wide text-white/40">
        <span>{deployment ? `DEPLOY ${deployment.id.slice(0, 8).toUpperCase()}` : t('NO DEPLOYMENT', 'KEIN DEPLOYMENT')}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {streamError && active && (
            <button className="max-w-full text-left text-amber-300 underline underline-offset-2" type="button" onClick={() => { setStreamError(false); setStreamRevision((value) => value + 1); }}>
              {t('Stream interrupted · reconnect', 'Stream unterbrochen · neu verbinden')}
            </button>
          )}
          <span className="flex items-center gap-1.5">
            {following ? <Play className="size-3" /> : <Pause className="size-3" />}
            {following ? t('FOLLOWING', 'FOLGT') : t('PAUSED', 'PAUSIERT')}
          </span>
        </span>
      </CardFooter>
    </Card>
  );
}
