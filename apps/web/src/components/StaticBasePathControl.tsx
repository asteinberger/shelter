import { AnimatePresence, motion } from 'motion/react';
import { Route, ScanSearch } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Field } from './ui';
import { Label } from './ui/label';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';
import {
  MAX_STATIC_BASE_PATH_LENGTH,
  normalizeStaticBasePath,
  staticBasePathError,
} from '../utils/static-base-path';
import { useI18n } from '@/i18n';

export function StaticBasePathControl({
  value,
  onChange,
  disabled,
  id = 'static-base-path',
  className,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const generatedId = useId();
  const radioName = `${id}-${generatedId}`;
  const manual = value !== null;
  const error = manual ? staticBasePathError(value) : undefined;

  return (
    <fieldset
      className={cn(
        'min-w-0 rounded-xl border bg-card p-4 text-card-foreground disabled:opacity-60',
        className,
      )}
      disabled={disabled}
    >
      <legend className="sr-only">{t('Hosting path for static files', 'Hosting-Pfad für statische Dateien')}</legend>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-muted/50 text-muted-foreground">
          <Route className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-sm font-semibold">{t('Hosting path', 'Hosting-Pfad')}</strong>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('For prebuilt static websites. Automatic detection is right for most projects.', 'Für fertig gebaute statische Websites. Automatik ist für die meisten Projekte richtig.')}
          </p>
        </div>
      </div>

      <RadioGroup
        value={manual ? 'manual' : 'auto'}
        onValueChange={(next) => onChange(next === 'manual' ? (value ?? '/') : null)}
        className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2"
        aria-label={t('Choose hosting path', 'Hosting-Pfad festlegen')}
        disabled={disabled}
      >
        <Label
          htmlFor={`${radioName}-auto`}
          className={cn(
            'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-[color,background-color,border-color,box-shadow] outline-none',
            'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
            'has-[button:disabled]:cursor-not-allowed',
            !manual
              ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
              : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
          )}
        >
          <RadioGroupItem id={`${radioName}-auto`} value="auto" className="mt-0.5 focus-visible:ring-0" />
          <span className="min-w-0">
            <strong className="block text-xs font-semibold">{t('Automatic', 'Automatisch')}</strong>
            <small className="mt-0.5 block font-normal leading-relaxed text-muted-foreground">{t('Detect after build', 'Nach dem Build erkennen')}</small>
          </span>
        </Label>
        <Label
          htmlFor={`${radioName}-manual`}
          className={cn(
            'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-[color,background-color,border-color,box-shadow] outline-none',
            'has-[button:focus-visible]:border-ring has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/25',
            'has-[button:disabled]:cursor-not-allowed',
            manual
              ? 'border-ring/50 bg-accent text-accent-foreground ring-1 ring-ring/20'
              : 'border-border bg-background/50 hover:bg-accent/50 hover:text-accent-foreground',
          )}
        >
          <RadioGroupItem id={`${radioName}-manual`} value="manual" className="mt-0.5 focus-visible:ring-0" />
          <span className="min-w-0">
            <strong className="block text-xs font-semibold">{t('Manual', 'Manuell')}</strong>
            <small className="mt-0.5 block font-normal leading-relaxed text-muted-foreground">{t('Force / or a custom prefix', '/ oder eigenen Prefix erzwingen')}</small>
          </span>
        </Label>
      </RadioGroup>

      <AnimatePresence initial={false}>
        {manual && (
          <motion.div
            className="mt-4 overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Field
              id={id}
              label={t('Path on the domain', 'Pfad auf der Domain')}
              value={value}
              onChange={(event) => onChange(normalizeStaticBasePath(event.target.value))}
              onBlur={(event) => onChange(normalizeStaticBasePath(event.target.value, true))}
              placeholder="/shop"
              maxLength={MAX_STATIC_BASE_PATH_LENGTH + 1}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              error={error}
              disabled={disabled}
            />
            {!error && (
              <p className="mt-3 flex min-w-0 items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2.5 text-xs leading-relaxed text-foreground">
                <ScanSearch className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
                <span className="min-w-0 flex-1">{t('The website will be served at', 'Die Website wird unter')} <code className="break-all font-mono font-semibold">{value === '/' ? '/' : `${value}/`}</code>{t('.', ' bereitgestellt.')}</span>
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {t('The manual path must match the', 'Der manuelle Pfad muss zum beim Build kompilierten')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">base</code> {t('or', 'bzw.')} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">publicPath</code> {t('value compiled during the build. Asset URLs are not rewritten.', '-Wert passen. Die Asset-URLs selbst werden nicht umgeschrieben.')}
      </p>
    </fieldset>
  );
}
