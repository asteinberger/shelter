import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useI18n } from '@/i18n';
import { submitGitHubManifest } from '../utils/github-manifest';

export function useGitHubUpgradeManifest() {
  const { t } = useI18n();

  return useMutation({
    mutationFn: async () => {
      const started = await api.startGitHubUpgradeManifest();
      submitGitHubManifest(started.registrationUrl, started.manifest);
    },
    onMutate: () => {
      toast.loading(
        t('Preparing replacement GitHub App …', 'GitHub-Ersatz-App wird vorbereitet …'),
        { id: 'github-upgrade' },
      );
    },
    onSuccess: () => toast.dismiss('github-upgrade'),
    onError: (error) => {
      toast.error(
        t('Replacement GitHub App could not be prepared', 'GitHub-Ersatz-App konnte nicht vorbereitet werden'),
        {
          description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
          id: 'github-upgrade',
        },
      );
    },
  });
}
