import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button as ShadcnButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton as ShadcnSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

type ShadcnButtonProps = React.ComponentProps<typeof ShadcnButton>;
type LegacyButtonVariant = 'primary' | 'dark' | 'danger';

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  asChild,
  ...props
}: Omit<ShadcnButtonProps, 'variant' | 'size'> & {
  variant?: ShadcnButtonProps['variant'] | LegacyButtonVariant;
  size?: ShadcnButtonProps['size'] | 'md';
  loading?: boolean;
}) {
  const mappedVariant: ShadcnButtonProps['variant'] = variant === 'danger'
    ? 'destructive'
    : variant === 'primary' || variant === 'dark'
      ? 'default'
      : variant;
  const mappedSize: ShadcnButtonProps['size'] = size === 'md' ? 'default' : size;

  if (asChild) {
    return (
      <ShadcnButton
        asChild
        variant={mappedVariant}
        size={mappedSize}
        className={className}
        {...props}
      >
        {children}
      </ShadcnButton>
    );
  }

  return (
    <ShadcnButton
      variant={mappedVariant}
      size={mappedSize}
      className={className}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="animate-spin" aria-hidden="true" />}
      {children}
    </ShadcnButton>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generatedId = useId();
  const id = props.id ?? props.name ?? generatedId;
  const descriptionId = hint || error ? `${id}-description` : undefined;

  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <Input
        id={id}
        className="h-9"
        aria-describedby={descriptionId}
        aria-invalid={Boolean(error) || undefined}
        {...props}
      />
      {(error || hint) && (
        <p
          className={cn('text-xs leading-relaxed text-muted-foreground', error && 'text-destructive')}
          id={descriptionId}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generatedId = useId();
  const id = props.id ?? props.name ?? generatedId;
  const descriptionId = hint || error ? `${id}-description` : undefined;

  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <NativeSelect
        id={id}
        className="w-full [&_[data-slot=native-select]]:h-9"
        aria-describedby={descriptionId}
        aria-invalid={Boolean(error) || undefined}
        {...props}
      >
        {children}
      </NativeSelect>
      {(error || hint) && (
        <p
          className={cn('text-xs leading-relaxed text-muted-foreground', error && 'text-destructive')}
          id={descriptionId}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const successStates = new Set(['live', 'success', 'running', 'active', 'connected', 'ready']);
const progressStates = new Set(['deploying', 'preparing', 'building', 'checking', 'switching', 'queued', 'pending', 'provisioning']);
const failedStates = new Set(['failed', 'error', 'cancelled', 'offline', 'deletion_failed']);

export function StatusBadge({ status, className }: { status?: string; className?: string }) {
  const { t } = useI18n();
  const statusLabels: Record<string, string> = {
    live: 'Live',
    success: t('Successful', 'Erfolgreich'),
    running: t('Running', 'Läuft'),
    active: t('Active', 'Aktiv'),
    connected: t('Connected', 'Verbunden'),
    ready: t('Ready', 'Bereit'),
    deploying: t('Deploying', 'Wird deployed'),
    preparing: t('Preparing', 'Wird vorbereitet'),
    building: t('Building', 'Build läuft'),
    checking: t('Health check', 'Healthcheck'),
    switching: t('Activating', 'Wird aktiviert'),
    queued: t('Queued', 'In Warteschlange'),
    pending: t('Pending', 'Ausstehend'),
    provisioning: t('Provisioning', 'Wird eingerichtet'),
    failed: t('Failed', 'Fehlgeschlagen'),
    error: t('Error', 'Fehler'),
    cancelled: t('Cancelled', 'Abgebrochen'),
    offline: 'Offline',
    stopped: t('Stopped', 'Gestoppt'),
    draft: t('Draft', 'Entwurf'),
    deletion_failed: t('Deletion failed', 'Löschung fehlgeschlagen'),
    unknown: t('Unknown', 'Unbekannt'),
  };
  const normalized = (status ?? 'unknown').toLowerCase();
  const tone = failedStates.has(normalized)
    ? 'border-destructive/25 bg-background text-foreground'
    : 'border-border bg-background text-foreground';
  const dotTone = successStates.has(normalized)
    ? 'bg-success'
    : progressStates.has(normalized)
      ? 'bg-info'
      : failedStates.has(normalized)
        ? 'bg-destructive'
        : 'bg-current';

  return (
    <Badge variant="outline" className={cn('h-6 gap-1.5 px-2.5 font-medium shadow-none', tone, className)}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          dotTone,
          progressStates.has(normalized) && 'status-pulse',
        )}
        aria-hidden="true"
      />
      {statusLabels[normalized] ?? status}
    </Badge>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">{eyebrow}</div>}
        <h1 className="min-w-0 text-balance text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {description && <p className="mt-2 min-w-0 max-w-2xl text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function ErrorState({
  title,
  message,
  action,
}: {
  title?: string;
  message?: string;
  action?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Alert variant="destructive" className="mx-auto max-w-2xl items-start p-4">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{title ?? t('Something went wrong', 'Etwas ist schiefgelaufen')}</AlertTitle>
      {message && <AlertDescription>{message}</AlertDescription>}
      {action && <div className="col-span-full mt-3 sm:col-start-2">{action}</div>}
    </Alert>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <ShadcnSkeleton className={cn('min-h-8', className)} aria-hidden="true" />;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
