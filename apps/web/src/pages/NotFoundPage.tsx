import { Compass, Home, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Button } from '../components/ui';
import { useI18n } from '@/i18n';

export function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto grid min-h-[calc(100svh-5rem)] w-full max-w-3xl place-items-center px-4 py-10 sm:px-6">
      <Empty className="min-h-80 border-0 p-6">
        <EmptyHeader className="max-w-md">
          <EmptyMedia variant="icon">
            <Compass aria-hidden="true" />
          </EmptyMedia>
          <p className="text-sm font-medium text-muted-foreground">{t('Error 404', 'Fehler 404')}</p>
          <EmptyTitle className="text-2xl">
            <h1>{t('Page not found', 'Seite nicht gefunden')}</h1>
          </EmptyTitle>
          <EmptyDescription>
            {t(
              'The page does not exist, has moved, or no longer belongs to this workspace.',
              'Die gesuchte Seite existiert nicht, wurde verschoben oder gehört nicht mehr zu diesem Workspace.',
            )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="mt-2 flex-row flex-wrap justify-center">
          <Button asChild>
            <Link to="/"><Home aria-hidden="true" /> {t('Back to overview', 'Zur Übersicht')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/projects/new"><Plus aria-hidden="true" /> {t('New project', 'Neues Projekt')}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
