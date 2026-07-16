import { AlertTriangle, Check, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import type { GitHubPreviewCapability } from '../types';
import { trustedGitHubRemediationUrl } from '../utils/github';
import { Button } from './ui';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';

function CapabilityCheck({
  available,
  children,
}: {
  available: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center" aria-hidden="true">
        {available
          ? <Check className="size-4 text-success" />
          : <X className="size-4 text-destructive" />}
      </span>
      <span>
        <span className="sr-only">
          {available ? t('Available: ', 'Vorhanden: ') : t('Missing: ', 'Fehlt: ')}
        </span>
        {children}
      </span>
    </li>
  );
}

export function GitHubPreviewCapabilityNotice({
  capability,
  refreshing,
  onRetry,
}: {
  capability?: GitHubPreviewCapability | null;
  refreshing?: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();

  if (!capability) {
    return (
      <Alert variant="destructive">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>{t('GitHub readiness could not be verified', 'GitHub-Bereitschaft konnte nicht verifiziert werden')}</AlertTitle>
        <AlertDescription>{t('Preview deployments stay disabled until Shelter can verify the required permission and webhook event.', 'Preview-Deployments bleiben deaktiviert, bis Shelter die erforderliche Berechtigung und das Webhook-Event verifizieren kann.')}</AlertDescription>
        <Button variant="outline" size="sm" className="col-start-2 mt-2 w-fit" onClick={onRetry} loading={refreshing}>
          {!refreshing && <RefreshCw aria-hidden="true" />} {t('Check again', 'Erneut prüfen')}
        </Button>
      </Alert>
    );
  }

  if (capability.ready) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-success/25 bg-success/5 p-4 sm:flex-row sm:items-center sm:justify-between" role="status">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-success/25 bg-background">
            <ShieldCheck className="size-4 text-success" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-medium">{t('GitHub App ready', 'GitHub App bereit')}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t('Pull requests can be read and the pull_request webhook is active.', 'Pull Requests können gelesen werden und der pull_request-Webhook ist aktiv.')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onRetry} loading={refreshing}>
          {!refreshing && <RefreshCw aria-hidden="true" />} {t('Recheck', 'Neu prüfen')}
        </Button>
      </div>
    );
  }

  const installationApproval = capability.remediation === 'approve_installation_update';
  const appUpdate = capability.remediation === 'update_existing_app';
  const remediationUrl = trustedGitHubRemediationUrl(capability.remediationUrl);
  const step = installationApproval
    ? t('Step 2 of 2 · Installation approval', 'Schritt 2 von 2 · Installationsfreigabe')
    : appUpdate
      ? t('Step 1 of 2 · App permissions', 'Schritt 1 von 2 · App-Berechtigungen')
      : null;
  const actionLabel = installationApproval
    ? t('Approve on GitHub', 'Auf GitHub freigeben')
    : appUpdate
      ? t('Update GitHub App', 'GitHub App aktualisieren')
      : t('Connect GitHub', 'GitHub verbinden');

  return (
    <Alert
      role="alert"
      className="border-warning/35 bg-warning/5 p-4 [&>svg]:text-warning"
    >
      <ShieldCheck aria-hidden="true" />
      <div className="col-start-2 min-w-0">
        {step && (
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-warning">
            {step}
          </p>
        )}
        <AlertTitle>
          {installationApproval
            ? t('Approve the updated GitHub access', 'Aktualisierten GitHub-Zugriff freigeben')
            : appUpdate
              ? t('GitHub access needs an update', 'GitHub-Zugriff muss aktualisiert werden')
              : t('Connect a GitHub App first', 'Verbinde zuerst eine GitHub App')}
        </AlertTitle>
        <AlertDescription className="mt-1 max-w-3xl">
          {installationApproval
            ? t('The app is configured correctly. The owner of this repository installation must now approve the new read-only pull request access.', 'Die App ist korrekt konfiguriert. Der Inhaber dieser Repository-Installation muss jetzt den neuen Lesezugriff auf Pull Requests freigeben.')
            : appUpdate
              ? t('Add read-only pull request access and the pull_request event to the existing GitHub App. Shelter keeps preview builds disabled until every check passes.', 'Ergänze in der bestehenden GitHub App den Lesezugriff auf Pull Requests und das pull_request-Event. Shelter lässt Preview-Builds deaktiviert, bis alle Prüfungen erfolgreich sind.')
              : t('Register the dedicated GitHub App before enabling pull request previews.', 'Registriere die eigene GitHub App, bevor du Pull-Request-Previews aktivierst.')}
        </AlertDescription>
      </div>

      <ul className="col-start-2 mt-4 grid gap-2 text-sm" aria-label={t('Required GitHub capabilities', 'Erforderliche GitHub-Funktionen')}>
        <CapabilityCheck available={capability.pullRequestsPermission}>
          {t('Pull requests permission: Read', 'Pull-Requests-Berechtigung: Lesen')}
        </CapabilityCheck>
        {capability.installationChecked && (
          <>
            <CapabilityCheck available={Boolean(capability.installationPullRequestsPermission)}>
              {t('Repository installation: Pull requests read access', 'Repository-Installation: Lesezugriff auf Pull Requests')}
            </CapabilityCheck>
            <CapabilityCheck available={Boolean(capability.installationPullRequestEvent)}>
              {t('Repository installation: pull_request events', 'Repository-Installation: pull_request-Events')}
            </CapabilityCheck>
            <CapabilityCheck available={!capability.installationSuspended}>
              {t('Repository installation active', 'Repository-Installation aktiv')}
            </CapabilityCheck>
          </>
        )}
        <CapabilityCheck available={capability.pullRequestEvent}>
          {t('Webhook event: pull_request', 'Webhook-Event: pull_request')}
        </CapabilityCheck>
      </ul>

      <div className="col-start-2 mt-4 flex flex-wrap gap-2">
        {remediationUrl ? (
          <Button asChild size="sm">
            <a href={remediationUrl} target="_blank" rel="noopener noreferrer">
              {actionLabel} <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link to="/settings/github">{actionLabel}</Link>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRetry} loading={refreshing}>
          {!refreshing && <RefreshCw aria-hidden="true" />} {t('Check now', 'Jetzt prüfen')}
        </Button>
      </div>
      {capability.configured && (
        <p className="col-start-2 mt-3 text-xs leading-relaxed text-muted-foreground">
          {t('GitHub opens in a new tab. Save or approve the change there, then return—Shelter checks the connection automatically.', 'GitHub öffnet sich in einem neuen Tab. Speichere oder bestätige die Änderung dort und kehre zurück – Shelter prüft die Verbindung automatisch.')}
        </p>
      )}
    </Alert>
  );
}
