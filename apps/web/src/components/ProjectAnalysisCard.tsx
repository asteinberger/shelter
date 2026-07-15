import {
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  FolderTree,
  KeyRound,
  LoaderCircle,
  PackageCheck,
  Server,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { ProjectAnalysisApplication, ProjectSourceAnalysis } from '../types';
import { analysisApplication } from '../utils/project-analysis';
import { useI18n } from '../i18n';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';

export type ProjectAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';

interface ProjectAnalysisCardProps {
  status: ProjectAnalysisStatus;
  analysis?: ProjectSourceAnalysis | null;
  selectedApplicationId?: string;
  onSelectApplication?: (applicationId: string) => void;
  onShowAdvanced?: () => void;
  onRetry?: () => void;
  missingEnvironmentKeys?: string[];
  onAddEnvironmentKeys?: () => void;
  context?: 'create' | 'replacement';
  applicationSelectionDescription?: string;
  className?: string;
}

function displayFramework(application: ProjectAnalysisApplication) {
  const normalized = application.framework.toLowerCase();
  const known: Record<string, string> = {
    next: 'Next.js',
    nextjs: 'Next.js',
    react: 'React',
    vite: 'Vite',
    astro: 'Astro',
    node: 'Node.js',
    dockerfile: 'Dockerfile',
    static: 'Static HTML',
    files: 'File storage',
  };
  return known[normalized] ?? application.framework;
}

function confidencePercent(confidence: number) {
  const normalized = confidence <= 1 ? confidence * 100 : confidence;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[0.68rem] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn('truncate text-sm font-medium', mono && 'font-mono text-xs')} title={value}>{value}</dd>
    </div>
  );
}

export function ProjectAnalysisCard({
  status,
  analysis,
  selectedApplicationId = '',
  onSelectApplication,
  onShowAdvanced,
  onRetry,
  missingEnvironmentKeys = [],
  onAddEnvironmentKeys,
  context = 'create',
  applicationSelectionDescription,
  className,
}: ProjectAnalysisCardProps) {
  const { t } = useI18n();

  if (status === 'idle') return null;

  if (status === 'analyzing') {
    return (
      <Card className={cn('gap-0 overflow-hidden border-primary/20 bg-primary/[0.025] py-0 shadow-none', className)} data-testid="project-analysis-loading">
        <CardContent className="flex items-start gap-3 p-4 sm:p-5" role="status" aria-live="polite">
          <span className="relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border bg-background">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border bg-background">
              <LoaderCircle className="size-2.5 animate-spin" aria-hidden="true" />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <strong className="text-sm font-medium">{t('Analyzing project …', 'Projekt wird analysiert …')}</strong>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t('Shelter is reading manifests and app entry points. You can keep configuring the project.', 'Shelter liest Manifeste und App-Einstiegspunkte. Du kannst das Projekt währenddessen weiter konfigurieren.')}
            </p>
            <div className="mt-3 grid max-w-lg grid-cols-3 gap-2" aria-hidden="true">
              <Skeleton className="h-1.5 min-h-0" />
              <Skeleton className="h-1.5 min-h-0" />
              <Skeleton className="h-1.5 min-h-0" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (status === 'error' || !analysis) {
    return (
      <Alert className={cn('border-amber-500/25 bg-amber-500/[0.035]', className)} data-testid="project-analysis-error">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{t('Automatic analysis is unavailable', 'Automatische Analyse nicht verfügbar')}</AlertTitle>
        <AlertDescription className="grid gap-3">
          <p>{context === 'replacement'
            ? t('You can still upload this version. Shelter will keep the saved settings and run its normal detection during the build.', 'Du kannst diese Version trotzdem hochladen. Shelter behält die gespeicherten Einstellungen bei und führt beim Build die normale Erkennung aus.')
            : t('You can still create the project. Shelter will use the settings below and run its normal detection during the build.', 'Du kannst das Projekt trotzdem anlegen. Shelter verwendet die Einstellungen unten und führt beim Build die normale Erkennung aus.')}</p>
          {onRetry && <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onRetry}>{t('Analyze again', 'Erneut analysieren')}</Button>}
        </AlertDescription>
      </Alert>
    );
  }

  if (analysis.applications.length === 0) {
    return (
      <Alert className={cn('border-border bg-muted/20', className)} data-testid="project-analysis-empty">
        <Code2 aria-hidden="true" />
        <AlertTitle>{t('No application entry point found', 'Kein App-Einstiegspunkt gefunden')}</AlertTitle>
        <AlertDescription>
          {context === 'replacement'
            ? t('You can still upload this version. Shelter will verify the source again during the build.', 'Du kannst diese Version trotzdem hochladen. Shelter prüft die Quelle beim Build erneut.')
            : t('Shelter can still create this project and will verify the source again during the build.', 'Shelter kann das Projekt trotzdem anlegen und prüft die Quelle beim Build erneut.')}
        </AlertDescription>
      </Alert>
    );
  }

  const selected = analysisApplication(analysis, selectedApplicationId) ?? analysis.applications[0];
  if (!selected) return null;
  const framework = displayFramework(selected);
  const frameworkWithVersion = selected.frameworkVersion ? `${framework} ${selected.frameworkVersion}` : framework;
  const confidence = typeof selected.confidence === 'number'
    ? `${confidencePercent(selected.confidence)}%`
    : {
        high: t('High confidence', 'Hohe Sicherheit'),
        medium: t('Medium confidence', 'Mittlere Sicherheit'),
        low: t('Low confidence', 'Niedrige Sicherheit'),
      }[selected.confidence];
  const renderingLabels: Record<string, string> = {
    ssr: t('Server-rendered', 'Server-gerendert'),
    spa: t('Single-page app', 'Single-Page-App'),
    static: t('Static website', 'Statische Website'),
    server: t('Application server', 'Anwendungsserver'),
    container: t('Custom container', 'Eigener Container'),
    files: t('File storage', 'Dateiablage'),
  };
  const rendering = renderingLabels[selected.rendering] ?? selected.rendering;
  const root = !selected.rootDirectory || selected.rootDirectory === '.'
    ? t('Repository root', 'Repository-Root')
    : selected.rootDirectory;

  return (
    <Card className={cn('gap-0 overflow-hidden border-primary/20 bg-primary/[0.022] py-0 shadow-none', className)} data-testid="project-analysis-ready">
      <CardHeader className="gap-3 border-b bg-background/45 px-4 py-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-primary shadow-xs">
            <PackageCheck className="size-4" aria-hidden="true" />
            <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground">
              <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
            </span>
          </span>
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              <span>{frameworkWithVersion} {t('detected', 'erkannt')}</span>
              <Badge variant="outline" className="h-5 text-[0.66rem]">{confidence}</Badge>
            </CardTitle>
            <CardDescription className="mt-1 leading-relaxed">
              {rendering} · {selected.packageManager || t('No package manager', 'Kein Package Manager')}
            </CardDescription>
          </div>
        </div>
        {onShowAdvanced && (
          <Button type="button" variant="ghost" size="sm" className="w-fit text-xs text-muted-foreground" onClick={onShowAdvanced}>
            <Settings2 aria-hidden="true" /> {t('Detected · Change', 'Erkannt · Ändern')}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-5 px-4 py-4 sm:px-5 sm:py-5">
        {analysis.applications.length > 1 && (
          <div className="space-y-2.5">
            <div>
              <strong className="text-sm font-medium">{t('{count} applications found', '{count} Anwendungen gefunden', { count: analysis.applications.length })}</strong>
              <p className="mt-0.5 text-xs text-muted-foreground">{applicationSelectionDescription ?? (context === 'replacement'
                ? t('Choose which detected application to compare with the saved project settings.', 'Wähle, welche erkannte Anwendung du mit den gespeicherten Projekteinstellungen vergleichen möchtest.')
                : t('Choose the application Shelter should deploy.', 'Wähle die Anwendung, die Shelter deployen soll.'))}</p>
            </div>
            <RadioGroup
              value={selected.id}
              onValueChange={onSelectApplication}
              className="grid gap-2 md:grid-cols-2"
              aria-label={t('Detected applications', 'Erkannte Anwendungen')}
            >
              {analysis.applications.map((application) => {
                const checked = application.id === selected.id;
                const applicationFramework = displayFramework(application);
                return (
                  <Label
                    key={application.id}
                    htmlFor={`detected-application-${application.id}`}
                    className={cn(
                      'flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-background/70 p-3 transition-colors',
                      'has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
                      checked ? 'border-primary/45 bg-primary/[0.045]' : 'hover:bg-accent/40',
                    )}
                  >
                    <RadioGroupItem id={`detected-application-${application.id}`} value={application.id} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{application.name || applicationFramework}</span>
                      <span className="mt-0.5 block truncate font-mono text-[0.68rem] font-normal text-muted-foreground">{application.rootDirectory || '.'}</span>
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Label>
                );
              })}
            </RadioGroup>
          </div>
        )}

        <dl className="grid gap-x-5 gap-y-4 rounded-lg border bg-background/55 p-3.5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label={t('Rendering', 'Rendering')} value={rendering} />
          <Detail label={t('Root directory', 'Root-Verzeichnis')} value={root} mono={root !== t('Repository root', 'Repository-Root')} />
          <Detail label="Package Manager" value={selected.packageManager || '—'} mono />
          <Detail label={t('Build command', 'Build-Befehl')} value={selected.buildCommand || t('No build step', 'Kein Build-Schritt')} mono={Boolean(selected.buildCommand)} />
          <Detail label={t('Start command', 'Start-Befehl')} value={selected.startCommand || t('Managed by Shelter', 'Von Shelter verwaltet')} mono={Boolean(selected.startCommand)} />
          <Detail label={t('Output directory', 'Ausgabeordner')} value={selected.outputDirectory || '—'} mono />
          <Detail label={t('Internal port', 'Interner Port')} value={selected.port ? String(selected.port) : '—'} mono />
          <Detail label="Healthcheck" value={selected.healthcheckPath || '/'} mono />
        </dl>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FolderTree className="size-3.5" aria-hidden="true" /> {t('Why Shelter recognized this', 'Warum Shelter das erkannt hat')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selected.evidence.slice(0, 5).map((evidence) => (
                <Badge key={evidence} variant="secondary" className="max-w-full font-mono text-[0.65rem] font-normal" title={evidence}>
                  <span className="truncate">{evidence}</span>
                </Badge>
              ))}
              {selected.evidence.length === 0 && <span className="text-xs text-muted-foreground">{t('Project structure', 'Projektstruktur')}</span>}
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <KeyRound className="size-3.5" aria-hidden="true" /> {t('Environment keys', 'Umgebungsvariablen')}
            </div>
            {selected.environmentKeys.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {selected.environmentKeys.slice(0, 8).map((key) => <Badge key={key} variant="outline" className="font-mono text-[0.65rem]">{key}</Badge>)}
                {selected.environmentKeys.length > 8 && <Badge variant="secondary">+{selected.environmentKeys.length - 8}</Badge>}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{t('None declared', 'Keine deklariert')}</span>
            )}
            {missingEnvironmentKeys.length > 0 && onAddEnvironmentKeys && (
              <Button type="button" variant="outline" size="sm" className="mt-1 h-8 text-xs" onClick={onAddEnvironmentKeys}>
                <Braces aria-hidden="true" /> {t('Add missing variables', 'Fehlende Variablen hinzufügen')}
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          <Server className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{selected.spaFallback
            ? t('Client-side routes will fall back to index.html automatically.', 'Clientseitige Routen werden automatisch auf index.html zurückgeführt.')
            : context === 'replacement'
              ? t('Shelter validates this detection again during the build.', 'Shelter validiert diese Erkennung beim Build erneut.')
              : t('Shelter validates this detection again before the first build.', 'Shelter validiert diese Erkennung vor dem ersten Build erneut.')}</span>
        </div>
      </CardContent>
    </Card>
  );
}
