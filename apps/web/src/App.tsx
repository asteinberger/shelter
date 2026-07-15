import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api } from './api/client';
import { AppShell } from './components/AppShell';
import { Button, ErrorState } from './components/ui';
import { Spinner } from './components/ui/spinner';
import { Brand } from './components/Brand';
import { BRAND_NAME, SESSION_EXPIRED_EVENT } from './lib/brand';
import { isStaleClientError, recoverFromStaleClientError } from './utils/stale-client';
import { localize, useI18n } from './i18n';
import type { Session } from './types';

const OverviewPage = lazy(() => import('./pages/OverviewPage').then((module) => ({ default: module.OverviewPage })));
const ProjectsPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const DeploymentPage = lazy(() => import('./pages/DeploymentPage').then((module) => ({ default: module.DeploymentPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const NewProjectPage = lazy(() => import('./pages/NewProjectPage').then((module) => ({ default: module.NewProjectPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })));
const ProjectPage = lazy(() => import('./pages/ProjectPage').then((module) => ({ default: module.ProjectPage })));
const ServerMetricsPage = lazy(() => import('./pages/ServerMetricsPage').then((module) => ({ default: module.ServerMetricsPage })));
const ApiSettingsPage = lazy(() => import('./pages/ApiSettingsPage').then((module) => ({ default: module.ApiSettingsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const UploadProjectSourcePage = lazy(() => import('./pages/UploadProjectSourcePage').then((module) => ({ default: module.UploadProjectSourcePage })));

function AppLoading() {
  const { t } = useI18n();
  return (
    <div className="grid min-h-svh place-items-center p-6" aria-live="polite" aria-label={t(`Loading ${BRAND_NAME}`, `${BRAND_NAME} wird geladen`)}>
      <div className="flex flex-col items-center gap-5 rounded-xl border bg-card px-10 py-8 text-card-foreground shadow-sm">
        <Brand />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" aria-hidden="true" />
          {t('Loading workspace', 'Workspace wird geladen')}
        </div>
      </div>
    </div>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (recoverFromStaleClientError(error)) return;
    console.error(`${BRAND_NAME} UI error`, error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const staleClient = isStaleClientError(this.state.error);
    return (
      <main className="grid min-h-svh place-items-center p-6">
        <ErrorState
          title={staleClient
            ? localize(`${BRAND_NAME} was updated`, `${BRAND_NAME} wurde aktualisiert`)
            : localize('This view could not be loaded', 'Diese Ansicht konnte nicht geladen werden')}
          message={staleClient
            ? localize('This open tab still uses the previous version. Load the current version to continue.', 'Dieser offene Tab verwendet noch die vorherige Version. Lade die aktuelle Version, um fortzufahren.')
            : localize('An unexpected rendering error occurred. Your data was not changed.', 'Ein unerwarteter Darstellungsfehler ist aufgetreten. Deine Daten wurden nicht verändert.')}
          action={<Button onClick={() => window.location.reload()}>{staleClient
            ? localize('Load current version', 'Aktuelle Version laden')
            : localize('Reload view', 'Ansicht neu laden')}</Button>}
        />
      </main>
    );
  }
}

export function App() {
  const { t } = useI18n();
  const location = useLocation();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: api.session,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
  });

  useEffect(() => {
    const handleSessionExpired = () => {
      queryClient.setQueryData<Session>(['session'], { user: null, csrfToken: null });
      queryClient.cancelQueries();
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [queryClient]);

  if (sessionQuery.isLoading) return <AppLoading />;

  const unauthorized = sessionQuery.error instanceof ApiError && sessionQuery.error.status === 401;
  if (sessionQuery.isError && !unauthorized) {
    return (
      <main className="grid min-h-svh place-items-center p-6">
        <ErrorState
          title={t(`${BRAND_NAME} is unavailable`, `${BRAND_NAME} ist nicht erreichbar`)}
          message={sessionQuery.error instanceof Error ? sessionQuery.error.message : t('The session could not be loaded.', 'Die Sitzung konnte nicht geladen werden.')}
          action={<Button onClick={() => sessionQuery.refetch()}>{t('Try again', 'Erneut versuchen')}</Button>}
        />
      </main>
    );
  }

  const session: Session = sessionQuery.data ?? { user: null, csrfToken: null };
  const authenticated = Boolean(session.user) && !unauthorized;

  if (!authenticated && location.pathname !== '/login') {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  }
  if (authenticated && location.pathname === '/login') return <Navigate to="/dashboard" replace />;

  return (
    <AppErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<AppLoading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AppShell session={session} />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<OverviewPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<NewProjectPage />} />
            <Route path="projects/:id" element={<ProjectPage />} />
            <Route path="projects/:id/deployments/:deploymentId" element={<DeploymentPage />} />
            <Route path="projects/:id/upload" element={<UploadProjectSourcePage />} />
            <Route path="server" element={<ServerMetricsPage />} />
            <Route
              path="settings"
              element={<Navigate to={`/settings/cloudflare${location.search}${location.hash}`} replace />}
            />
            <Route path="settings/cloudflare" element={<SettingsPage key="cloudflare" section="cloudflare" />} />
            <Route path="settings/github" element={<SettingsPage key="github" section="github" />} />
            <Route path="settings/api" element={<ApiSettingsPage />} />
            <Route path="settings/security" element={<SettingsPage key="security" section="security" />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  );
}
