import { ArrowRight, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CloudflareAccessProtection } from '../types';
import { useI18n } from '@/i18n';
import { Button } from './ui';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export function ProductionSafetyAlert({ accessProtection }: { accessProtection?: CloudflareAccessProtection }) {
  const { t } = useI18n();
  if (accessProtection?.status !== 'action_required' || !accessProtection.panelDomain) return null;

  return (
    <Alert variant="destructive" className="items-start border-destructive/50 bg-destructive/[0.045] p-4">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{t('Production unsafe', 'Produktion unsicher')}</AlertTitle>
      <AlertDescription>
        {t(
          'The panel at {hostname} is published, but no administrator confirmation for Cloudflare Access is stored. Shelter does not verify Access policies automatically. Deployments remain available.',
          'Das Panel unter {hostname} ist veröffentlicht, aber es ist keine Administrator-Bestätigung für Cloudflare Access gespeichert. Shelter prüft Access-Policies nicht automatisch. Deployments bleiben verfügbar.',
          { hostname: accessProtection.panelDomain },
        )}
      </AlertDescription>
      <div className="col-span-full mt-2 sm:col-start-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/settings/cloudflare">{t('Review panel protection', 'Panel-Schutz prüfen')} <ArrowRight aria-hidden="true" /></Link>
        </Button>
      </div>
    </Alert>
  );
}
