import { AlertTriangle, UploadCloud } from 'lucide-react';
import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { useI18n } from '@/i18n';

export function NavigationGuard({
  when,
  locked = false,
  title,
  description,
  stayLabel,
}: {
  when: boolean;
  locked?: boolean;
  title: string;
  description: string;
  stayLabel?: string;
}) {
  const { t } = useI18n();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    when && currentLocation.pathname !== nextLocation.pathname
  ));

  useEffect(() => {
    if (!when && blocker.state === 'blocked') blocker.reset();
  }, [blocker, when]);

  const blocked = blocker.state === 'blocked';

  return (
    <AlertDialog
      open={blocked}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className={locked ? 'bg-accent/15 text-accent-foreground' : 'bg-warning/15 text-warning'}>
            {locked ? <UploadCloud /> : <AlertTriangle />}
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {locked ? (
            <AlertDialogCancel>{stayLabel ?? t('Stay on this page', 'Auf dieser Seite bleiben')}</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel>{t('Continue editing', 'Weiter bearbeiten')}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => blocker.state === 'blocked' && blocker.proceed()}
              >
                {t('Discard changes', 'Änderungen verwerfen')}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
