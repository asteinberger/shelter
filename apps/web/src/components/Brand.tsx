import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { BRAND_CLAIM, BRAND_NAME } from '@/lib/brand';
import { ShelterFrog } from './ShelterFrog';
import { useI18n } from '@/i18n';

interface BrandProps {
  compact?: boolean;
  inverse?: boolean;
  linkTo?: string;
  showClaim?: boolean;
}

export function Brand({ compact = false, inverse = false, linkTo = '/', showClaim = false }: BrandProps) {
  const { t } = useI18n();
  return (
    <Link
      className={cn(
        'group inline-flex w-fit items-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        inverse ? 'text-sidebar-foreground' : 'text-foreground',
      )}
      to={linkTo}
      aria-label={t('Shelter home', 'Shelter Startseite')}
    >
      <span
        className={cn(
          'grid size-8 place-items-center rounded-md bg-[var(--brand)] text-[var(--brand-foreground)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--brand-foreground)_12%,transparent)] transition-transform group-hover:-translate-y-px',
          compact && 'size-7',
        )}
        aria-hidden="true"
      >
        <ShelterFrog className={compact ? 'size-[1.15rem]' : 'size-[1.35rem]'} />
      </span>
      {!compact && (
        <span className="grid gap-0.5 leading-none">
          <span className="text-base font-semibold tracking-tight">{BRAND_NAME}</span>
          {showClaim && <span className="text-[0.65rem] font-medium tracking-[0.06em] text-muted-foreground">{BRAND_CLAIM}</span>}
        </span>
      )}
    </Link>
  );
}
