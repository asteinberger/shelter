import { Check, Languages } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useI18n, type Locale } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

const localeOptions: Array<{ value: Locale; label: string; nativeLabel: string }> = [
  { value: 'en', label: 'English', nativeLabel: 'English' },
  { value: 'de', label: 'German', nativeLabel: 'Deutsch' },
];

interface LanguageToggleProps {
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  variant?: ComponentProps<typeof Button>['variant'];
}

export function LanguageToggle({ className, align = 'end', side = 'bottom', variant = 'outline' }: LanguageToggleProps) {
  const { locale, setLocale, t } = useI18n();
  const currentLocale = localeOptions.find((option) => option.value === locale)!;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="icon"
          className={cn('relative', className)}
          aria-label={t(
            'Change language, currently {language}',
            'Sprache ändern, aktuell {language}',
            { language: currentLocale.nativeLabel },
          )}
          title={t('Change language', 'Sprache ändern')}
        >
          <Languages className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="w-44">
        <DropdownMenuLabel>{t('Language', 'Sprache')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {localeOptions.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => setLocale(option.value)}
            className="justify-between"
          >
            <span>{option.value === 'de' ? option.nativeLabel : option.label}</span>
            {locale === option.value && <Check className="size-4" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
