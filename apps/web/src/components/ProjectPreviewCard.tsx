import { ExternalLink, Files, FolderTree, ImageOff, LoaderCircle, MonitorUp, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project } from '../types';
import { formatRelative } from '../utils/format';
import { Button } from './ui';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Skeleton } from './ui/skeleton';
import { useI18n, type Translate } from '@/i18n';
import { isFileStorageProject } from '../utils/project-runtime';

interface ProjectPreviewCardProps {
  project: Project;
  publicUrl?: string;
}

function previewDescription(project: Project, t: Translate): string {
  if (project.preview?.status === 'pending') return t('Shelter is capturing the active deployment.', 'Shelter erstellt gerade einen Screenshot des aktiven Deployments.');
  if (project.preview?.status === 'unavailable' && project.preview.reason === 'not_html') {
    return t('The homepage does not return HTML. This is probably an API service.', 'Die Startseite liefert keine HTML-Seite – wahrscheinlich ist dies ein API-Dienst.');
  }
  if (project.preview?.status === 'unavailable') {
    return t('The deployment is online, but its screenshot could not be created.', 'Das Deployment ist online, aber der Screenshot konnte nicht erzeugt werden.');
  }
  return t('Automatic screenshot of the active deployment.', 'Automatischer Screenshot des aktiven Deployments.');
}

export function ProjectPreviewCard({ project, publicUrl }: ProjectPreviewCardProps) {
  const { t, locale } = useI18n();
  const preview = project.preview;
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageLoaded(false);
    setImageFailed(false);
  }, [preview?.deploymentId, preview?.imageUrl]);

  if (!project.activeDeploymentId) return null;

  if (isFileStorageProject(project)) {
    const storageUrl = publicUrl?.replace(/\/$/, '');
    const exampleUrl = storageUrl ? `${storageUrl}/path/to/file.ext` : '/path/to/file.ext';
    return (
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle>{t('File storage', 'Dateiablage')}</CardTitle>
          <CardDescription>{t('Files are published directly and keep their original folder paths.', 'Dateien werden direkt veröffentlicht und behalten ihre ursprünglichen Ordnerpfade.')}</CardDescription>
          {publicUrl && (
            <CardAction>
              <Button asChild variant="ghost" size="sm">
                <a href={publicUrl} target="_blank" rel="noreferrer">{t('Open storage', 'Ablage öffnen')} <ExternalLink /></a>
              </Button>
            </CardAction>
          )}
        </CardHeader>

        <CardContent className="p-0">
          <div className="relative isolate grid min-h-72 place-items-center overflow-hidden bg-[radial-gradient(circle_at_top_left,var(--muted),transparent_45%)] p-6 sm:p-10">
            <div className="pointer-events-none absolute inset-0 -z-10 opacity-50 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(to_bottom,black,transparent)]" />
            <div className="grid w-full max-w-xl justify-items-center text-center">
              <span className="grid size-14 place-items-center rounded-2xl border bg-background shadow-sm">
                <Files className="size-6 text-muted-foreground" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{t('Your files have a home', 'Deine Dateien haben ein Zuhause')}</h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                {t(
                  'Use the public domain followed by the original file path. Folder browsing stays private and missing paths return 404.',
                  'Verwende die öffentliche Domain zusammen mit dem ursprünglichen Dateipfad. Ordnerlisten bleiben privat und fehlende Pfade liefern 404.',
                )}
              </p>
              <div className="mt-5 grid w-full min-w-0 gap-2 rounded-lg border bg-background/90 p-3 text-left shadow-sm">
                <span className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <FolderTree className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {t('Example URL · illustrative only', 'Beispiel-URL · nur zur Veranschaulichung')}
                </span>
                <code className="block min-w-0 truncate text-xs text-muted-foreground" title={exampleUrl}>
                  {exampleUrl}
                </code>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {t('Replace path/to/file.ext with the real path from your upload.', 'Ersetze path/to/file.ext durch den tatsächlichen Pfad aus deinem Upload.')}
                </span>
              </div>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5" /> {t('Dotfiles and system metadata stay protected', 'Dotfiles und Systemmetadaten bleiben geschützt')}</span>
          <span>{t('No application runtime required', 'Keine App-Laufzeit erforderlich')}</span>
        </CardFooter>
      </Card>
    );
  }

  const ready = preview?.status === 'ready' && Boolean(preview.imageUrl) && !imageFailed;
  const pending = !preview || preview.status === 'pending';
  const unavailable = preview?.status === 'unavailable' || imageFailed;
  const displayUrl = publicUrl?.replace(/^https?:\/\//, '') ?? t('Internal deployment preview', 'Interne Deployment-Vorschau');

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle>{t('Website preview', 'Website-Vorschau')}</CardTitle>
        <CardDescription>{previewDescription(project, t)}</CardDescription>
        {publicUrl && (
          <CardAction>
            <Button asChild variant="ghost" size="sm">
              <a href={publicUrl} target="_blank" rel="noreferrer">{t('Open', 'Öffnen')} <ExternalLink /></a>
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="p-0">
        <div className="bg-[radial-gradient(circle_at_top_left,var(--muted),transparent_45%)] p-3 sm:p-5">
          <div className="overflow-hidden rounded-xl border bg-background shadow-[0_20px_50px_-28px_rgba(0,0,0,0.55)]">
            <div className="flex h-10 items-center gap-3 border-b bg-muted/55 px-3">
              <div className="flex shrink-0 gap-1.5" aria-hidden="true">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
              </div>
              <div className="min-w-0 flex-1 rounded-md border bg-background/80 px-3 py-1 text-center font-mono text-[0.68rem] text-muted-foreground shadow-xs">
                <span className="block truncate">{displayUrl}</span>
              </div>
              <span className="w-10 shrink-0" aria-hidden="true" />
            </div>

            <div className="relative aspect-[16/9] max-h-[34rem] min-h-52 overflow-hidden bg-muted/30" aria-live="polite">
              {ready && (
                <>
                  {!imageLoaded && <Skeleton className="absolute inset-0 rounded-none" />}
                  <img
                    key={preview.imageUrl}
                    src={preview.imageUrl}
                    alt={t('Screenshot of website {name}', 'Screenshot der Website {name}', { name: project.name })}
                    className={`size-full object-cover object-top transition-opacity duration-500 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
                    onLoad={() => setImageLoaded(true)}
                    onError={() => setImageFailed(true)}
                  />
                </>
              )}

              {pending && (
                <div className="absolute inset-0 grid place-items-center p-8 text-center" role="status">
                  <div className="grid max-w-sm justify-items-center gap-3">
                    <span className="grid size-11 place-items-center rounded-xl border bg-background shadow-sm">
                      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{t('Preparing preview', 'Vorschau wird vorbereitet')}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('The worker is opening the active version in an isolated browser window.', 'Der Worker öffnet die aktive Version in einem isolierten Browserfenster.')}</p>
                    </div>
                  </div>
                </div>
              )}

              {unavailable && (
                <div className="absolute inset-0 grid place-items-center p-8 text-center">
                  <div className="grid max-w-md justify-items-center gap-3">
                    <span className="grid size-12 place-items-center rounded-xl border bg-background shadow-sm">
                      <ImageOff className="size-5 text-muted-foreground" />
                    </span>
                    <div>
                      <p className="text-sm font-medium">{t('No visual preview available', 'Keine visuelle Vorschau verfügbar')}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {imageFailed ? t('The saved preview image could not be loaded.', 'Das gespeicherte Vorschaubild konnte nicht geladen werden.') : previewDescription(project, t)}
                      </p>
                    </div>
                    {publicUrl && (
                      <Button asChild variant="outline" size="sm" className="mt-1">
                        <a href={publicUrl} target="_blank" rel="noreferrer">{t('Open response directly', 'Antwort direkt öffnen')} <ExternalLink /></a>
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/15 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><MonitorUp className="size-3.5" /> {t('Automatically after every successful deployment', 'Automatisch nach jedem erfolgreichen Deployment')}</span>
        {preview?.capturedAt && (
          <span>{preview.status === 'ready' ? t('Captured', 'Aufgenommen') : t('Checked', 'Geprüft')} {formatRelative(preview.capturedAt, locale)}</span>
        )}
      </CardFooter>
    </Card>
  );
}
