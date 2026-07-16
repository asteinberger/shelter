import { AlertTriangle, ArrowRightLeft, Check, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n';
import type { GitHubPreviewCapability } from '../types';
import { trustedGitHubAppInstallationUrl, trustedGitHubRemediationUrl } from '../utils/github';
import { useGitHubUpgradeManifest } from '../hooks/useGitHubUpgradeManifest';
import { Button } from './ui';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';

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

export function GitHubAppUpgradeImpact() {
  const { t } = useI18n();

  return (
    <div className="grid gap-3 text-sm">
      <div className="rounded-lg border bg-muted/25 p-3.5">
        <p className="font-medium">{t('Already configured', 'Bereits vorkonfiguriert')}</p>
        <ul className="mt-2 grid gap-1.5 text-muted-foreground">
          <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> {t('Read repository contents and pull requests', 'Repository-Inhalte und Pull Requests lesen')}</li>
          <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> {t('Report deployment status to commits', 'Deployment-Status an Commits melden')}</li>
          <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" /> {t('Receive push and pull_request webhooks', 'Push- und pull_request-Webhooks empfangen')}</li>
        </ul>
      </div>
      <div className="rounded-lg border border-warning/25 bg-warning/5 p-3.5">
        <p className="font-medium">{t('What happens next', 'So geht es weiter')}</p>
        <ol className="mt-2 grid list-decimal gap-1.5 pl-4 text-muted-foreground">
          <li>{t('Review the prefilled App on GitHub and choose a unique name.', 'Prüfe die vorausgefüllte App bei GitHub und wähle einen eindeutigen Namen.')}</li>
          <li>{t('Install it for the same accounts and repositories that Shelter currently uses.', 'Installiere sie für dieselben Accounts und Repositories, die Shelter aktuell verwendet.')}</li>
          <li>{t('Shelter verifies repository access, then activates the replacement and preserves existing project connections, auto-deploy, and previews.', 'Shelter prüft den Repository-Zugriff, aktiviert dann die Ersatz-App und erhält bestehende Projektverknüpfungen, Auto-Deploy und Previews.')}</li>
        </ol>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('If the required repositories are missing, Shelter keeps the current GitHub App active. Production deployments stay online throughout the upgrade. The previous App is not deleted automatically.', 'Fehlen erforderliche Repositories, lässt Shelter die aktuelle GitHub App aktiv. Produktions-Deployments bleiben während des gesamten Upgrades online. Die vorherige App wird nicht automatisch gelöscht.')}
        </p>
      </div>
    </div>
  );
}

function formattedUpgradeExpiry(value: string | null, locale: 'en' | 'de') {
  if (!value) return null;
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime())) return null;
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(expiry);
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
  const { locale, t } = useI18n();
  const upgrade = useGitHubUpgradeManifest();

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

  const upgradePending = capability.upgradePending;

  if (capability.ready && !upgradePending) {
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

  const installationApproval = !upgradePending && capability.remediation === 'approve_installation_update';
  const appUpdate = upgradePending || capability.remediation === 'update_existing_app';
  const upgradeInstallUrl = upgradePending
    ? trustedGitHubAppInstallationUrl(capability.upgradeInstallUrl)
    : undefined;
  const upgradeExpiry = upgradePending
    ? formattedUpgradeExpiry(capability.upgradeExpiresAt, locale)
    : null;
  const remediationUrl = trustedGitHubRemediationUrl(capability.remediationUrl);
  const step = installationApproval
    ? t('Step 2 of 2 · Installation approval', 'Schritt 2 von 2 · Installationsfreigabe')
    : upgradePending
      ? t('Replacement setup in progress', 'Einrichtung der Ersatz-App läuft')
      : appUpdate
        ? t('Preconfigured permissions upgrade', 'Vorkonfiguriertes Berechtigungs-Upgrade')
        : null;
  const actionLabel = installationApproval
    ? t('Approve on GitHub', 'Auf GitHub freigeben')
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
            : upgradePending
              ? t('Replacement GitHub App ready to install', 'GitHub-Ersatz-App kann installiert werden')
              : appUpdate
                ? t('GitHub App upgrade required', 'GitHub-App-Upgrade erforderlich')
                : t('Connect a GitHub App first', 'Verbinde zuerst eine GitHub App')}
        </AlertTitle>
        <AlertDescription className="mt-1 max-w-3xl">
          {installationApproval
            ? t('The app is configured correctly. The owner of this repository installation must now approve the new read-only pull request access.', 'Die App ist korrekt konfiguriert. Der Inhaber dieser Repository-Installation muss jetzt den neuen Lesezugriff auf Pull Requests freigeben.')
            : upgradePending
              ? t('The preconfigured replacement App was created on GitHub. Install it for the same accounts and repositories that Shelter currently uses to finish the verified switch.', 'Die vorkonfigurierte Ersatz-App wurde bei GitHub erstellt. Installiere sie für dieselben Accounts und Repositories, die Shelter aktuell verwendet, um den geprüften Wechsel abzuschließen.')
              : appUpdate
                ? t('Shelter can create a replacement GitHub App with the required read-only pull request access and webhook event already selected. GitHub manifests cannot modify the connected App.', 'Shelter kann eine GitHub-Ersatz-App erstellen, in der der erforderliche Lesezugriff auf Pull Requests und das Webhook-Event bereits ausgewählt sind. GitHub-Manifeste können die verbundene App nicht verändern.')
                : t('Register the dedicated GitHub App before enabling pull request previews.', 'Registriere die eigene GitHub App, bevor du Pull-Request-Previews aktivierst.')}
        </AlertDescription>
        {upgradeExpiry && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('This replacement setup expires on {date}.', 'Diese Ersatz-App-Einrichtung läuft am {date} ab.', { date: upgradeExpiry })}
          </p>
        )}
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
        {appUpdate ? (
          <>
            {upgradePending ? (
              upgradeInstallUrl ? (
                <Button asChild size="sm">
                  <a href={upgradeInstallUrl} target="_blank" rel="noopener noreferrer">
                    {t('Continue replacement setup', 'Einrichtung der Ersatz-App fortsetzen')}
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              ) : (
                <Button size="sm" disabled>
                  {t('Replacement installation unavailable', 'Installation der Ersatz-App nicht verfügbar')}
                </Button>
              )
            ) : (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm">
                    <ArrowRightLeft aria-hidden="true" />
                    {t('Create preconfigured replacement', 'Vorkonfigurierte Ersatz-App erstellen')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="sm:max-w-lg">
                  <AlertDialogHeader>
                    <AlertDialogMedia className="bg-warning/10 text-warning">
                      <ArrowRightLeft aria-hidden="true" />
                    </AlertDialogMedia>
                    <AlertDialogTitle>
                      {t('Create a replacement GitHub App?', 'Eine GitHub-Ersatz-App erstellen?')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('GitHub will register a new App because manifests cannot change an existing App. Shelter fills in the required permissions and events for you.', 'GitHub registriert eine neue App, weil Manifeste eine bestehende App nicht verändern können. Shelter trägt die erforderlichen Berechtigungen und Events für dich ein.')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>

                  <GitHubAppUpgradeImpact />

                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={upgrade.isPending}>
                      {t('Cancel', 'Abbrechen')}
                    </AlertDialogCancel>
                    <Button
                      type="button"
                      onClick={() => upgrade.mutate()}
                      loading={upgrade.isPending}
                    >
                      {!upgrade.isPending && <ArrowRightLeft aria-hidden="true" />}
                      {upgrade.isPending
                        ? t('Opening GitHub …', 'GitHub wird geöffnet …')
                        : t('Continue to GitHub', 'Weiter zu GitHub')}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {!upgradePending && remediationUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={remediationUrl} target="_blank" rel="noopener noreferrer">
                  {t('Update current App manually', 'Bestehende App manuell aktualisieren')}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            )}
          </>
        ) : remediationUrl ? (
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
          {appUpdate
            ? upgradePending
              ? t('Your current GitHub App remains active. Shelter switches only after the replacement installation provides access to every required repository.', 'Deine aktuelle GitHub App bleibt aktiv. Shelter wechselt erst, wenn die Ersatz-App-Installation Zugriff auf alle erforderlichen Repositories bietet.')
              : t('The preconfigured replacement opens on GitHub. Shelter switches over only after GitHub confirms its installation.', 'Die vorkonfigurierte Ersatz-App öffnet sich bei GitHub. Shelter wechselt erst, nachdem GitHub ihre Installation bestätigt hat.')
            : t('GitHub opens in a new tab. Save or approve the change there, then return—Shelter checks the connection automatically.', 'GitHub öffnet sich in einem neuen Tab. Speichere oder bestätige die Änderung dort und kehre zurück – Shelter prüft die Verbindung automatisch.')}
        </p>
      )}
    </Alert>
  );
}
