import type { Translate } from '@/i18n';

export type GitHubCallbackTone = 'success' | 'warning' | 'error';

export interface GitHubCallbackNotice {
  tone: GitHubCallbackTone;
  title: string;
  description: string;
}

export function githubCallbackNotice(
  status: string,
  message: string | null,
  t: Translate,
): GitHubCallbackNotice {
  if (status === 'upgraded') {
    return {
      tone: 'success',
      title: t('Replacement GitHub App is active', 'GitHub-Ersatz-App ist aktiv'),
      description: t(
        'Existing project connections, auto-deploy, and pull request previews were preserved. You can now remove the previous GitHub App manually.',
        'Bestehende Projektverknüpfungen, Auto-Deploy und Pull-Request-Previews wurden erhalten. Du kannst die vorherige GitHub App jetzt manuell entfernen.',
      ),
    };
  }

  if (status === 'upgrade_incomplete') {
    return {
      tone: 'warning',
      title: t('Replacement setup is incomplete', 'Einrichtung der Ersatz-App ist unvollständig'),
      description: t(
        'The replacement App is still missing required permissions or access to one or more linked repositories. Your current GitHub App remains active. Continue setup and grant access to the same repositories.',
        'Der Ersatz-App fehlen noch erforderliche Berechtigungen oder der Zugriff auf mindestens ein verknüpftes Repository. Deine aktuelle GitHub App bleibt aktiv. Setze die Einrichtung fort und gib dieselben Repositories frei.',
      ),
    };
  }

  if (status === 'connected' || status === 'registered' || status === 'installed') {
    return {
      tone: 'success',
      title: status === 'installed'
        ? t('GitHub installation connected', 'GitHub-Installation verbunden')
        : t('GitHub App connected', 'GitHub App verbunden'),
      description: t(
        'Repositories can now be selected directly in Shelter.',
        'Repositories können jetzt direkt in Shelter ausgewählt werden.',
      ),
    };
  }

  return {
    tone: 'error',
    title: t('GitHub could not be connected', 'GitHub konnte nicht verbunden werden'),
    description: message ?? t(
      'Setup was cancelled or rejected by GitHub.',
      'Die Einrichtung wurde abgebrochen oder von GitHub abgelehnt.',
    ),
  };
}
