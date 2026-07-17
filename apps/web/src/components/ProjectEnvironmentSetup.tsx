import { ExternalLink, FileSearch, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { ProjectEnvironmentRequirement } from '../types';
import { useI18n } from '../i18n';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';

interface EnvironmentHelp {
  href: string;
  label: string;
}

const ENVIRONMENT_HELP: Record<string, EnvironmentHelp> = {
  ANTHROPIC_API_KEY: {
    href: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  OPENAI_API_KEY: {
    href: 'https://platform.openai.com/api-keys',
    label: 'OpenAI Platform',
  },
};

interface ProjectEnvironmentSetupProps {
  requirements: ProjectEnvironmentRequirement[];
  values: Readonly<Record<string, string>>;
  errors?: Readonly<Record<string, string | undefined>>;
  skippedKeys?: ReadonlySet<string>;
  showErrors?: boolean;
  disabled?: boolean;
  onChange: (key: string, value: string) => void;
  onSkippedChange?: (key: string, skipped: boolean) => void;
  className?: string;
}

function requirementSource(requirement: ProjectEnvironmentRequirement): string | null {
  const source = requirement.sources[0];
  if (!source) return null;
  return `${source.path}:${source.line}`;
}

export function ProjectEnvironmentSetup({
  requirements,
  values,
  errors = {},
  skippedKeys = new Set(),
  showErrors = false,
  disabled = false,
  onChange,
  onSkippedChange,
  className,
}: ProjectEnvironmentSetupProps) {
  const { t } = useI18n();
  if (requirements.length === 0) return null;

  const requiredCount = requirements.filter((requirement) => requirement.required).length;
  const unresolvedCount = requirements.filter((requirement) => (
    requirement.required
    && !skippedKeys.has(requirement.key)
    && !(values[requirement.key] ?? '').trim()
  )).length;

  return (
    <Card className={cn('gap-0 overflow-hidden border-primary/20 py-0 shadow-sm', className)} data-testid="project-environment-setup">
      <CardHeader className="gap-3 border-b bg-primary/[0.025] px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-primary shadow-xs">
            <KeyRound className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <CardTitle className="text-base">{t('Configure your environment', 'Umgebung konfigurieren')}</CardTitle>
            <CardDescription className="mt-1 max-w-2xl leading-relaxed">
              {t(
                'Shelter found variables referenced by this application. Add them now so the first deployment has everything it needs.',
                'Shelter hat Variablen gefunden, die diese Anwendung verwendet. Hinterlege sie jetzt, damit beim ersten Deployment alles vorhanden ist.',
              )}
            </CardDescription>
          </div>
        </div>
        <Badge variant={unresolvedCount > 0 ? 'default' : 'secondary'} className="w-fit shrink-0">
          {requiredCount === 0
            ? t('{count} suggested', '{count} vorgeschlagen', { count: requirements.length })
            : unresolvedCount > 0
              ? t('{count} required', '{count} erforderlich', { count: unresolvedCount })
              : t('Ready', 'Bereit')}
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-3 px-4 py-4 sm:px-5 sm:py-5">
        {requirements.map((requirement) => {
          const source = requirementSource(requirement);
          const help = ENVIRONMENT_HELP[requirement.key];
          const value = values[requirement.key] ?? '';
          const skipped = skippedKeys.has(requirement.key);
          const error = showErrors ? errors[requirement.key] : undefined;
          const descriptionId = `${requirement.key}-environment-description`;
          return (
            <div
              key={requirement.key}
              className={cn(
                'grid gap-3 rounded-xl border bg-background p-3.5 transition-colors sm:p-4',
                error && 'border-destructive/45 bg-destructive/[0.025]',
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Label htmlFor={`detected-environment-${requirement.key}`} className="font-mono text-sm font-semibold">
                    {requirement.key}
                  </Label>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant={requirement.required && !skipped ? 'default' : 'secondary'} className="h-5 text-[0.65rem]">
                      {skipped
                        ? t('Skipped', 'Übersprungen')
                        : requirement.required
                          ? t('Required', 'Erforderlich')
                          : t('Suggested', 'Vorgeschlagen')}
                    </Badge>
                    <Badge variant="outline" className="h-5 gap-1 text-[0.65rem]">
                      {requirement.secret ? <LockKeyhole className="size-2.5" aria-hidden="true" /> : <ShieldCheck className="size-2.5" aria-hidden="true" />}
                      {requirement.visibility === 'public'
                        ? t('Public', 'Öffentlich')
                        : requirement.secret
                          ? t('Secret', 'Secret')
                          : t('Server-only', 'Nur Server')}
                    </Badge>
                    <Badge variant="outline" className="h-5 text-[0.65rem]">
                      {requirement.scope === 'build'
                        ? t('Build time', 'Build-Zeit')
                        : requirement.scope === 'runtime'
                          ? t('Runtime', 'Laufzeit')
                          : t('Build + runtime', 'Build + Laufzeit')}
                    </Badge>
                  </div>
                </div>
                {source && (
                  <span className="flex max-w-full items-center gap-1.5 truncate font-mono text-[0.68rem] text-muted-foreground" title={source}>
                    <FileSearch className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{source}</span>
                  </span>
                )}
              </div>

              <Input
                id={`detected-environment-${requirement.key}`}
                name={`detected-environment-${requirement.key}`}
                type={requirement.secret ? 'password' : 'text'}
                autoComplete={requirement.secret ? 'new-password' : 'off'}
                value={value}
                onChange={(event) => onChange(requirement.key, event.target.value)}
                placeholder={requirement.secret
                  ? t('Paste secret value', 'Secret-Wert einfügen')
                  : t('Enter value', 'Wert eingeben')}
                disabled={disabled}
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={descriptionId}
                maxLength={65_536}
              />

              <div id={descriptionId} className={cn('flex flex-wrap items-center justify-between gap-2 text-xs leading-relaxed text-muted-foreground', error && 'text-destructive')}>
                <span>{error ?? (requirement.visibility === 'public'
                  ? t('This value may be embedded in the public client bundle.', 'Dieser Wert kann in das öffentliche Client-Bundle eingebettet werden.')
                  : t('Encrypted after saving and never shown again.', 'Wird nach dem Speichern verschlüsselt und nicht wieder angezeigt.'))}</span>
                <span className="flex flex-wrap items-center gap-2">
                  {requirement.required && onSkippedChange && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => onSkippedChange(requirement.key, !skipped)}
                      disabled={disabled}
                    >
                      {skipped ? t('Require value', 'Wert wieder anfordern') : t('Skip for now', 'Vorerst überspringen')}
                    </Button>
                  )}
                  {help && (
                    <a
                      href={help.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {t('Where do I find this?', 'Wo finde ich das?')} · {help.label}
                      <ExternalLink className="size-3" aria-hidden="true" />
                    </a>
                  )}
                </span>
              </div>
            </div>
          );
        })}

        <Alert role="note" className="mt-1 border-border bg-muted/25">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>{t('Static analysis only', 'Nur statische Analyse')}</AlertTitle>
          <AlertDescription>
            {t(
              'Shelter never executes repository code or reads real .env files during this check. You can review every detected source above.',
              'Shelter führt bei dieser Prüfung keinen Repository-Code aus und liest keine echten .env-Dateien. Jede erkannte Fundstelle wird oben angezeigt.',
            )}
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
