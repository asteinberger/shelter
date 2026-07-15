import { motion } from 'motion/react';
import {
  Archive,
  CheckCircle2,
  FileArchive,
  FolderOpen,
  GitCompareArrows,
  KeyRound,
  PackageOpen,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Deployment, ProjectAnalysisApplication, ProjectSourceAnalysis } from '../types';
import { archiveFolder, type ArchiveProgress } from '../utils/archive';
import { collectFolderAnalysisFiles, collectZipAnalysisFiles } from '../utils/project-analysis-input';
import {
  AnalysisRequestCoordinator,
  analysisApplication,
  missingDetectedEnvironmentKeys,
  recommendedAnalysisApplicationId,
} from '../utils/project-analysis';
import { staticBasePathError } from '../utils/static-base-path';
import { cn } from '@/lib/utils';
import { ProjectAnalysisCard, type ProjectAnalysisStatus } from './ProjectAnalysisCard';
import { StaticBasePathControl } from './StaticBasePathControl';
import { Button } from './ui';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Progress } from './ui/progress';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import { useI18n } from '@/i18n';

type UploadKind = 'zip' | 'folder';

interface ProgressState {
  percent: number;
  label: string;
  detail: string;
}

export interface ReplacementProjectSettings {
  rootDirectory?: string;
  buildType?: string;
  port?: number;
}

export interface ReplacementAnalysisDifference {
  field: 'rootDirectory' | 'buildType' | 'port';
  current: string;
  detected: string;
}

const shelterManagedEnvironmentKeys = new Set(['PORT', 'HOSTNAME', 'NODE_ENV']);

function normalizedRootDirectory(value?: string | null) {
  const normalized = value?.trim().replace(/^\.\/$/, '') ?? '';
  return normalized || '.';
}

export function replacementAnalysisDifferences(
  application: ProjectAnalysisApplication | null | undefined,
  current: ReplacementProjectSettings,
): ReplacementAnalysisDifference[] {
  if (!application) return [];

  const differences: ReplacementAnalysisDifference[] = [];
  const currentRoot = normalizedRootDirectory(current.rootDirectory);
  const detectedRoot = normalizedRootDirectory(application.rootDirectory);
  if (currentRoot !== detectedRoot) {
    differences.push({ field: 'rootDirectory', current: currentRoot, detected: detectedRoot });
  }

  const currentBuildType = current.buildType?.trim() || 'auto';
  // `auto` delegates this choice to the detector, so a concrete detected
  // preset confirms the saved configuration instead of contradicting it.
  if (currentBuildType !== 'auto' && currentBuildType !== application.buildType) {
    differences.push({ field: 'buildType', current: currentBuildType, detected: application.buildType });
  }

  // Static/file runtimes use Shelter's managed Nginx port. The saved project
  // port matters only for an executable server or a custom container.
  const detectedPortIsRelevant = application.buildType === 'node'
    || application.buildType === 'dockerfile'
    || application.rendering === 'server'
    || application.rendering === 'ssr'
    || application.rendering === 'container';
  if (
    detectedPortIsRelevant
    && current.port !== undefined
    && application.port !== null
    && current.port !== application.port
  ) {
    differences.push({ field: 'port', current: String(current.port), detected: String(application.port) });
  }

  return differences;
}

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function ProjectSourceUpload({
  projectId,
  projectName,
  disabled,
  onClose,
  onQueued,
  onRedeploy,
  onPendingChange,
  onDirtyChange,
  redeployPending,
  initialStaticBasePath,
  supportsStaticBasePath = true,
  currentRootDirectory,
  currentBuildType,
  currentPort,
  currentEnvironmentKeys = [],
}: {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  onClose: () => void;
  onQueued: (deployment: Deployment) => void;
  onRedeploy?: (staticBasePath?: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  redeployPending?: boolean;
  initialStaticBasePath?: string | null;
  supportsStaticBasePath?: boolean;
  currentRootDirectory?: string;
  currentBuildType?: string;
  currentPort?: number;
  currentEnvironmentKeys?: string[];
}) {
  const { t } = useI18n();
  const zipInputId = useId();
  const folderInputId = useId();
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const preparedFolder = useRef<File | null>(null);
  const preparedUpload = useRef<{ file: File; uploadId: string; chunks: number } | null>(null);
  const analysisCoordinator = useRef(new AnalysisRequestCoordinator());
  const [uploadKind, setUploadKind] = useState<UploadKind>('zip');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [folderFiles, setFolderFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string>();
  const [completed, setCompleted] = useState(false);
  const [pending, setPending] = useState(false);
  const [staticBasePath, setStaticBasePath] = useState<string | null>(initialStaticBasePath ?? null);
  const [analysisStatus, setAnalysisStatus] = useState<ProjectAnalysisStatus>('idle');
  const [analysis, setAnalysis] = useState<ProjectSourceAnalysis | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState('');
  const folderSize = folderFiles.reduce((sum, file) => sum + file.size, 0);
  const hasSelection = Boolean(zipFile || folderFiles.length);
  const pathError = supportsStaticBasePath && staticBasePath !== null
    ? staticBasePathError(staticBasePath)
    : undefined;
  const dirty = !completed && (
    hasSelection
    || (supportsStaticBasePath && staticBasePath !== (initialStaticBasePath ?? null))
  );
  const selectedApplication = analysisApplication(analysis, selectedApplicationId);
  const analysisDifferences = replacementAnalysisDifferences(selectedApplication, {
    rootDirectory: currentRootDirectory,
    buildType: currentBuildType,
    port: currentPort,
  });
  const missingEnvironmentKeys = missingDetectedEnvironmentKeys(
    selectedApplication?.environmentKeys ?? [],
    currentEnvironmentKeys,
    shelterManagedEnvironmentKeys,
  );

  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  useEffect(() => () => analysisCoordinator.current.cancel(), []);

  useEffect(() => {
    if (!pending && !dirty) return undefined;
    const preventNavigation = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventNavigation);
    return () => window.removeEventListener('beforeunload', preventNavigation);
  }, [dirty, pending]);

  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [onPendingChange, pending]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  function resetAnalysis() {
    analysisCoordinator.current.cancel();
    setAnalysisStatus('idle');
    setAnalysis(null);
    setSelectedApplicationId('');
  }

  async function analyzeSelection(kind: UploadKind, file: File | null, files: File[]) {
    if (!file && files.length === 0) {
      resetAnalysis();
      return;
    }

    const request = analysisCoordinator.current.begin();
    setAnalysisStatus('analyzing');
    setAnalysis(null);
    setSelectedApplicationId('');
    try {
      const facts = kind === 'zip'
        ? await collectZipAnalysisFiles(file as File, { signal: request.signal })
        : await collectFolderAnalysisFiles(files, { signal: request.signal });
      const result = await api.analyzeProject(facts, request.signal);
      if (!analysisCoordinator.current.isCurrent(request.version)) return;
      setAnalysis(result);
      setSelectedApplicationId(recommendedAnalysisApplicationId(result));
      setAnalysisStatus('ready');
    } catch (caught) {
      if (isAbortError(caught) || !analysisCoordinator.current.isCurrent(request.version)) return;
      setAnalysis(null);
      setSelectedApplicationId('');
      setAnalysisStatus('error');
    }
  }

  function clearSelection() {
    if (pending) return;
    resetAnalysis();
    setZipFile(null);
    setFolderFiles([]);
    setProgress(null);
    setError(undefined);
    setCompleted(false);
    preparedFolder.current = null;
    preparedUpload.current = null;
    if (zipInput.current) zipInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }

  function changeKind(kind: UploadKind) {
    if (pending || kind === uploadKind) return;
    clearSelection();
    setUploadKind(kind);
  }

  function selectZip(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setZipFile(file);
    setFolderFiles([]);
    setError(undefined);
    setCompleted(false);
    preparedFolder.current = null;
    preparedUpload.current = null;
    void analyzeSelection('zip', file, []);
  }

  function selectFolder(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setFolderFiles(files);
    setZipFile(null);
    setError(undefined);
    setCompleted(false);
    preparedFolder.current = null;
    preparedUpload.current = null;
    void analyzeSelection('folder', null, files);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!hasSelection || pending || disabled || pathError) return;
    setPending(true);
    setError(undefined);
    setCompleted(false);
    try {
      let file = zipFile;
      if (uploadKind === 'folder') {
        file = preparedFolder.current;
        if (!file) {
          setProgress({
            percent: 2,
            label: t('Preparing folder', 'Ordner wird vorbereitet'),
            detail: t('{count} files', '{count} Dateien', { count: folderFiles.length }),
          });
          file = await archiveFolder(folderFiles, (archiveProgress: ArchiveProgress) => {
            const ratio = archiveProgress.totalBytes > 0
              ? archiveProgress.processedBytes / archiveProgress.totalBytes
              : archiveProgress.current / archiveProgress.total;
            setProgress({
              percent: 2 + ratio * 16,
              label: t('Archiving folder locally', 'Ordner wird lokal gepackt'),
              detail: t(
                '{processed} / {totalBytes} · File {current}/{total}',
                '{processed} / {totalBytes} · Datei {current}/{total}',
                {
                  processed: formatBytes(archiveProgress.processedBytes),
                  totalBytes: formatBytes(archiveProgress.totalBytes),
                  current: archiveProgress.current,
                  total: archiveProgress.total,
                },
              ),
            });
          });
          preparedFolder.current = file;
        }
      }
      if (!file) throw new Error(t('Select a ZIP archive or project folder.', 'Bitte wähle ein ZIP-Archiv oder einen Projektordner aus.'));

      let prepared = preparedUpload.current;
      if (!prepared || prepared.file !== file) {
        const uploaded = await api.prepareArchiveUpload(file, (upload) => {
          const ratio = upload.totalBytes > 0 ? upload.uploadedBytes / upload.totalBytes : 0;
          if (upload.phase === 'verifying') {
            setProgress({
              percent: 94,
              label: t('Verifying archive safely', 'Archiv wird sicher geprüft'),
              detail: t('Validating file paths and ZIP contents', 'Dateipfade und ZIP-Inhalt werden validiert'),
            });
          } else {
            setProgress({
              percent: 20 + ratio * 72,
              label: t('Uploading new files', 'Neue Dateien werden hochgeladen'),
              detail: t(
                '{uploaded} / {totalBytes} · Chunk {chunk}/{chunks}',
                '{uploaded} / {totalBytes} · Block {chunk}/{chunks}',
                {
                  uploaded: formatBytes(upload.uploadedBytes),
                  totalBytes: formatBytes(upload.totalBytes),
                  chunk: upload.chunk,
                  chunks: upload.chunks,
                },
              ),
            });
          }
        });
        prepared = { file, uploadId: uploaded.uploadId, chunks: uploaded.chunks };
        preparedUpload.current = prepared;
      }
      setProgress({
        percent: 98,
        label: t('Creating deployment', 'Deployment wird angelegt'),
        detail: t('The current version stays online until the new health check passes', 'Die laufende Version bleibt bis zum erfolgreichen Healthcheck online'),
      });
      const result = await api.attachUploadProjectSource(
        projectId,
        prepared.uploadId,
        supportsStaticBasePath ? staticBasePath : null,
      );
      setProgress({
        percent: 100,
        label: t('New version queued', 'Neue Version ist in der Warteschlange'),
        detail: t('The build starts automatically', 'Der Build startet automatisch'),
      });
      setCompleted(true);
      onQueued(result.deployment);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('The new files could not be uploaded.', 'Die neuen Dateien konnten nicht hochgeladen werden.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <motion.section
      ref={regionRef}
      className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      aria-labelledby="source-upload-title"
      aria-busy={pending}
      tabIndex={-1}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b p-5 sm:p-6">
          <div className="min-w-0">
            <CardTitle className="text-xl">
              <h2 id="source-upload-title">{t('Upload new version', 'Neue Version hochladen')}</h2>
            </CardTitle>
            <CardDescription className="mt-1 leading-relaxed">
              {t('Replace the files for', 'Ersetze die Dateien für')} <strong className="font-semibold text-foreground">{projectName}</strong> {t('and immediately start a new deployment.', 'und starte direkt ein neues Deployment.')}
            </CardDescription>
          </div>
          <Button type="button" variant="outline" size="icon" onClick={onClose} disabled={pending} aria-label={t('Close upload', 'Upload schließen')}>
            <X />
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          <div className="flex items-start gap-3 border-b bg-muted/30 px-5 py-3.5 text-sm text-muted-foreground sm:px-6">
            <ShieldCheck className="mt-0.5 shrink-0" size={17} aria-hidden="true" />
            <span className="leading-relaxed"><strong className="font-semibold text-foreground">{t('No downtime:', 'Ohne Ausfall:')}</strong> {t('The current version stays online until the new build passes its health check.', 'Die aktuelle Version bleibt online, bis der neue Build seinen Healthcheck bestanden hat.')}</span>
          </div>

          <form className="grid gap-4 p-5 sm:p-6" onSubmit={submit}>
        <RadioGroup
          value={uploadKind}
          onValueChange={(value) => changeKind(value as UploadKind)}
          disabled={pending}
          aria-label={t('Upload type', 'Upload-Typ')}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          <Label
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-[color,background-color,border-color,box-shadow]',
              'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
              'has-[button:disabled]:cursor-not-allowed has-[button:disabled]:opacity-60',
              uploadKind === 'zip'
                ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
                : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
            )}
          >
            <RadioGroupItem value="zip" />
            <FileArchive className="text-muted-foreground" size={16} /> {t('ZIP archive', 'ZIP-Archiv')}
          </Label>
          <Label
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-[color,background-color,border-color,box-shadow]',
              'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
              'has-[button:disabled]:cursor-not-allowed has-[button:disabled]:opacity-60',
              uploadKind === 'folder'
                ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
                : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
            )}
          >
            <RadioGroupItem value="folder" />
            <FolderOpen className="text-muted-foreground" size={16} /> {t('Folder', 'Ordner')}
          </Label>
        </RadioGroup>

        <input ref={zipInput} className="sr-only" id={zipInputId} type="file" accept=".zip,application/zip" onChange={selectZip} disabled={uploadKind !== 'zip' || pending} tabIndex={-1} aria-label={t('Select ZIP archive', 'ZIP-Archiv auswählen')} />
        <input ref={folderInput} className="sr-only" id={folderInputId} type="file" multiple webkitdirectory="" directory="" onChange={selectFolder} disabled={uploadKind !== 'folder' || pending} tabIndex={-1} aria-label={t('Select project folder', 'Projektordner auswählen')} />

        {hasSelection ? (
          <div className="grid min-h-24 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border bg-muted/20 p-4">
            <div className="grid size-10 place-items-center rounded-lg border bg-background text-muted-foreground"><Archive size={20} /></div>
            <div className="min-w-0">
              <strong className="block truncate text-sm font-semibold">{zipFile?.name ?? folderFiles[0]?.webkitRelativePath.split('/')[0] ?? t('Project folder', 'Projektordner')}</strong>
              <span className="mt-1 block text-xs text-muted-foreground">{zipFile ? formatBytes(zipFile.size) : t(
                '{count} files · {size} · archived locally',
                '{count} Dateien · {size} · wird lokal gepackt',
                { count: folderFiles.length, size: formatBytes(folderSize) },
              )}</span>
            </div>
            <Button variant="outline" size="icon" type="button" onClick={clearSelection} disabled={pending} aria-label={t('Remove selection', 'Auswahl entfernen')}><X /></Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="flex h-auto min-h-52 w-full flex-col items-center justify-center whitespace-normal rounded-xl border-dashed bg-background/50 px-5 py-8 text-center hover:bg-accent/50"
            onClick={() => (uploadKind === 'zip' ? zipInput.current : folderInput.current)?.click()}
            disabled={pending}
          >
            <div className="mb-4 text-muted-foreground">{uploadKind === 'zip' ? <PackageOpen size={28} /> : <FolderOpen size={28} />}</div>
            <strong className="text-lg font-semibold">{uploadKind === 'zip' ? t('Select ZIP archive', 'ZIP-Archiv auswählen') : t('Select project folder', 'Projektordner auswählen')}</strong>
            <span className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">{uploadKind === 'zip' ? t('Upload a prebuilt distribution or source code', 'Eine fertig gebaute Distribution oder den Quellcode hochladen') : t('The folder is archived as a ZIP locally only', 'Der Ordner wird ausschließlich lokal als ZIP gepackt')}</span>
            <span className="mt-4 text-xs text-muted-foreground">{t('Large uploads are transferred in secure 10 MB chunks', 'Große Uploads werden in sicheren 10-MB-Blöcken übertragen')}</span>
          </Button>
        )}

        <ProjectAnalysisCard
          status={analysisStatus}
          analysis={analysis}
          selectedApplicationId={selectedApplicationId}
          onSelectApplication={setSelectedApplicationId}
          onRetry={hasSelection ? () => void analyzeSelection(uploadKind, zipFile, folderFiles) : undefined}
          context="replacement"
        />

        {analysisDifferences.length > 0 && (
          <Alert className="border-amber-500/25 bg-amber-500/[0.035]" data-testid="replacement-analysis-differences">
            <GitCompareArrows aria-hidden="true" />
            <AlertTitle>{t('Source differs from the saved project settings', 'Quelle weicht von den gespeicherten Projekteinstellungen ab')}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{t(
                'You can still upload this version. Shelter keeps the saved settings and does not change them automatically.',
                'Du kannst diese Version trotzdem hochladen. Shelter behält die gespeicherten Einstellungen bei und ändert sie nicht automatisch.',
              )}</p>
              <div className="grid gap-2">
                {analysisDifferences.map((difference) => {
                  const label = difference.field === 'rootDirectory'
                    ? t('Root directory', 'Root-Verzeichnis')
                    : difference.field === 'buildType'
                      ? t('Build type', 'Build-Typ')
                      : t('Port', 'Port');
                  return (
                    <div key={difference.field} className="flex flex-wrap items-center gap-2 rounded-md border bg-background/65 px-3 py-2 text-xs">
                      <span className="min-w-24 font-medium text-foreground">{label}</span>
                      <Badge variant="outline" className="font-mono font-normal">{difference.current}</Badge>
                      <span aria-hidden="true" className="text-muted-foreground">→</span>
                      <Badge variant="secondary" className="font-mono font-normal">{difference.detected}</Badge>
                    </div>
                  );
                })}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {missingEnvironmentKeys.length > 0 && (
          <Alert className="border-border bg-muted/20" data-testid="replacement-analysis-environment-keys">
            <KeyRound aria-hidden="true" />
            <AlertTitle>{t('Environment keys are not configured yet', 'Umgebungsvariablen sind noch nicht konfiguriert')}</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{t(
                'The selected source declares these keys. Shelter does not create variables or change existing values during this upload.',
                'Die ausgewählte Quelle deklariert diese Keys. Shelter legt bei diesem Upload keine Variablen an und ändert keine bestehenden Werte.',
              )}</p>
              <div className="flex flex-wrap gap-1.5">
                {missingEnvironmentKeys.map((key) => <Badge key={key} variant="outline" className="font-mono text-[0.68rem]">{key}</Badge>)}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {supportsStaticBasePath && (
          <StaticBasePathControl
            id="replacement-static-base-path"
            value={staticBasePath}
            onChange={setStaticBasePath}
            disabled={pending || completed}
          />
        )}

        {progress && (
          <div className="rounded-lg border bg-muted/20 p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold">{completed ? <CheckCircle2 className="text-success" size={16} /> : <UploadCloud size={16} />}{progress.label}</span>
              <b className="font-mono text-xs text-muted-foreground">{Math.round(progress.percent)}%</b>
            </div>
            <small className="mt-1.5 block text-xs leading-relaxed text-muted-foreground">{progress.detail}</small>
            <Progress className="mt-3 h-1.5" value={progress.percent} aria-label={progress.label} />
          </div>
        )}

        {error && <Alert variant="destructive"><UploadCloud /><AlertTitle>{t('Upload failed', 'Upload fehlgeschlagen')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

        <footer className={cn('-mx-5 -mb-5 mt-1 flex flex-col-reverse items-stretch gap-3 border-t bg-muted/20 p-4 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:px-6', onRedeploy ? 'justify-between' : 'justify-end')}>
          {onRedeploy && (
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-8 w-full justify-start whitespace-normal text-left leading-relaxed text-muted-foreground sm:w-auto sm:whitespace-nowrap"
              onClick={() => onRedeploy(supportsStaticBasePath ? staticBasePath : undefined)}
              disabled={pending || disabled || completed || redeployPending || Boolean(pathError)}
              loading={redeployPending}
            >
              {supportsStaticBasePath ? t('Deploy current files with this path', 'Aktuelle Dateien mit dieser Pfadwahl deployen') : t('Redeploy current files', 'Aktuelle Dateien erneut deployen')}
            </Button>
          )}
          <Button type="submit" loading={pending} disabled={!hasSelection || disabled || completed || Boolean(pathError)}>
            {!pending && <UploadCloud size={16} />} {completed ? t('Deployment created', 'Deployment angelegt') : t('Upload & deploy', 'Hochladen & deployen')}
          </Button>
        </footer>
          </form>
        </CardContent>
      </Card>
    </motion.section>
  );
}
