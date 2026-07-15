import { Monitor, Moon, Sun } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Theme } from '@/lib/theme';
import { useTheme } from './ThemeProvider';
import { useI18n } from '@/i18n';

interface ThemeToggleProps {
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  variant?: ComponentProps<typeof Button>['variant'];
}

export function ThemeToggle({ className, align = 'end', side = 'bottom', variant = 'outline' }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  const currentLabel = resolvedTheme === 'dark' ? t('Dark', 'Dunkel') : t('Light', 'Hell');
  const themeOptions: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
    { value: 'light', label: t('Light', 'Hell'), icon: Sun },
    { value: 'dark', label: t('Dark', 'Dunkel'), icon: Moon },
    { value: 'system', label: t('System', 'System'), icon: Monitor },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="icon"
          className={cn('relative', className)}
          aria-label={t(
            'Change appearance, currently {appearance}',
            'Darstellung ändern, aktuell {appearance}',
            { appearance: currentLabel },
          )}
          title={t('Change appearance', 'Darstellung ändern')}
        >
          <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" aria-hidden="true" />
          <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="w-44">
        <DropdownMenuLabel>{t('Appearance', 'Darstellung')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          {themeOptions.map(({ value, label, icon: Icon }) => (
            <DropdownMenuRadioItem value={value} key={value}>
              <Icon aria-hidden="true" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
