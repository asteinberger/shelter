import type { GitHubManifestPayload } from '../types';
import { localize } from '@/i18n';
import { trustedGitHubManifestRegistrationUrl } from './github';

export function submitGitHubManifest(
  registrationUrl: string,
  manifest: GitHubManifestPayload,
) {
  const target = trustedGitHubManifestRegistrationUrl(registrationUrl);
  if (!target) {
    throw new Error(localize(
      'GitHub returned an invalid registration URL.',
      'GitHub hat eine ungültige Registrierungsadresse zurückgegeben.',
    ));
  }

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = target;
  form.hidden = true;

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  form.append(input);
  document.body.append(form);
  form.submit();
}
