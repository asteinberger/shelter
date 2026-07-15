import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronUp,
  Cloud,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Server,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../api/client';
import type { Session } from '../types';
import { userInitials, userLabel } from '../utils/format';
import { Brand } from './Brand';
import { LanguageToggle } from './LanguageToggle';
import { ThemeToggle } from './ThemeToggle';
import { Button, Skeleton } from './ui';
import { Avatar, AvatarFallback } from './ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Separator } from './ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import { cn } from '@/lib/utils';
import { BRAND_NAME } from '@/lib/brand';
import { useI18n } from '@/i18n';

function RouteFallback() {
  const { t } = useI18n();
  return (
    <div className="grid gap-6" aria-label={t('Loading page', 'Seite wird geladen')} role="status">
      <div className="space-y-3 border-b pb-7">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-11 w-full max-w-md" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}

export function AppShell({ session }: { session: Session }) {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileNavFirstRef = useRef<HTMLAnchorElement>(null);
  const label = userLabel(session.user);
  const navigation = useMemo(() => [
    { to: '/dashboard', label: t('Dashboard', 'Dashboard'), icon: LayoutDashboard, end: true },
    { to: '/projects', label: t('Projects', 'Projekte'), icon: FolderKanban, end: false },
    { to: '/server', label: t('Server', 'Server'), icon: Gauge, end: true },
    { to: '/settings/cloudflare', label: t('Settings', 'Einstellungen'), icon: Settings2, end: false },
  ], [t]);
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.setQueryData<Session>(['session'], { user: null, csrfToken: null });
      queryClient.clear();
      navigate('/login', { replace: true });
    },
    onError: (error) => toast.error(t('Sign out failed', 'Abmelden fehlgeschlagen'), {
      description: error instanceof Error ? error.message : t('Please try again.', 'Bitte versuche es erneut.'),
    }),
  });

  const routeTitle = useMemo(() => {
    if (location.pathname === '/' || location.pathname === '/dashboard') return t('Dashboard', 'Dashboard');
    if (location.pathname === '/projects') return t('Projects', 'Projekte');
    if (location.pathname === '/projects/new') return t('New project', 'Neues Projekt');
    // Dynamic project screens own their title because they can include the
    // project or deployment name once the corresponding query resolves.
    if (location.pathname.startsWith('/projects/')) return null;
    if (location.pathname === '/server') return t('Server metrics', 'Servermetriken');
    if (location.pathname === '/settings/cloudflare') return t('Cloudflare & routing', 'Cloudflare & Routing');
    if (location.pathname === '/settings/github') return 'GitHub';
    if (location.pathname === '/settings/api') return 'API & CLI';
    if (location.pathname === '/settings/security') return t('Security', 'Sicherheit');
    if (location.pathname.startsWith('/settings')) return t('Settings', 'Einstellungen');
    return t('Page not found', 'Seite nicht gefunden');
  }, [location.pathname, t]);

  useEffect(() => {
    setMenuOpen(false);
    if (routeTitle) document.title = `${routeTitle} · ${BRAND_NAME}`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.requestAnimationFrame(() => document.getElementById('main-content')?.focus({ preventScroll: true }));
  }, [location.pathname, routeTitle]);

  const workerOnline = overview.data?.system?.workerOnline;
  const nodeStatus = overview.isError
    ? { label: t('Status unknown', 'Status unbekannt'), detail: t('API unavailable', 'API nicht erreichbar'), dot: 'bg-muted-foreground' }
    : workerOnline === false
      ? { label: t('Worker offline', 'Worker offline'), detail: t('Action required', 'Eingriff erforderlich'), dot: 'bg-destructive' }
      : overview.isLoading
        ? { label: t('Checking status', 'Status wird geprüft'), detail: `${BRAND_NAME} Node`, dot: 'bg-warning' }
        : { label: t('Node operational', 'Node betriebsbereit'), detail: t('Worker connected', 'Worker verbunden'), dot: 'bg-success' };

  const renderSidebarContent = (mobile = false) => (
    <div className="flex h-full min-h-full flex-col overflow-y-auto bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Brand inverse />
      </div>

      <Separator className="bg-sidebar-border" />

      <div className="shrink-0 px-3 pt-4">
        <Button asChild className="w-full justify-start" size="lg">
          <NavLink to="/projects/new" onClick={() => mobile && setMenuOpen(false)}>
            <Plus aria-hidden="true" /> {t('New project', 'Neues Projekt')}
          </NavLink>
        </Button>
      </div>

      <nav className="grid shrink-0 gap-1 px-2 py-4" aria-label={t('Main navigation', 'Hauptnavigation')}>
        <p className="px-3 pb-2 text-xs font-medium text-muted-foreground">
          {t('Navigation', 'Navigation')}
        </p>
        {navigation.map(({ to, label: itemLabel, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            ref={mobile && to === '/dashboard' ? mobileNavFirstRef : undefined}
            onClick={() => mobile && setMenuOpen(false)}
            aria-current={to.startsWith('/settings') && location.pathname.startsWith('/settings') ? 'page' : undefined}
            className={({ isActive }) => {
              const settingsActive = to.startsWith('/settings') && location.pathname.startsWith('/settings');
              return cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50',
                isActive || settingsActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              );
            }}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{itemLabel}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto shrink-0 px-3 pb-3">
        <NavLink
          to="/server"
          onClick={() => mobile && setMenuOpen(false)}
          className="mb-3 flex items-center gap-3 rounded-md px-2 py-2 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50"
          aria-label={t(
            '{status}. Open server metrics',
            '{status}. Servermetriken öffnen',
            { status: nodeStatus.label },
          )}
        >
          <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn('size-1.5 shrink-0 rounded-full', nodeStatus.dot, workerOnline && 'status-pulse')} aria-hidden="true" />
              <strong className="truncate text-xs font-medium">{nodeStatus.label}</strong>
            </div>
            <span className="block truncate text-xs text-muted-foreground">{nodeStatus.detail}</span>
          </div>
          {(overview.data?.cloudflare?.connected || overview.data?.system?.tunnelConfigured) && (
            <Cloud className="size-4 text-muted-foreground" aria-label={t('Cloudflare connected', 'Cloudflare verbunden')} />
          )}
        </NavLink>

        <Separator className="mb-3 bg-sidebar-border" />

        <div className="flex items-center gap-1 px-0.5 py-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-2 px-1.5 py-1 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                aria-label={t(
                  'Open administrator menu for {name}',
                  'Administratormenü für {name} öffnen',
                  { name: label },
                )}
              >
                <Avatar className="size-8 border border-sidebar-border">
                  <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
                    {userInitials(label)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-xs font-medium">{label}</strong>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{t('Administrator', 'Administrator')}</span>
                </span>
                <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel className="grid gap-0.5">
                <span className="truncate text-foreground">{label}</span>
                <span className="font-normal">{t('Administrator', 'Administrator')}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <NavLink to="/settings/security" onClick={() => mobile && setMenuOpen(false)}>
                  <ShieldCheck aria-hidden="true" /> {t('Security', 'Sicherheit')}
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={logout.isPending}
                onSelect={() => logout.mutate()}
              >
                <LogOut aria-hidden="true" /> {logout.isPending ? t('Signing out …', 'Wird abgemeldet …') : t('Sign out', 'Abmelden')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!mobile && (
            <>
              <LanguageToggle
                side="top"
                align="end"
                variant="ghost"
                className="size-7 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              />
              <ThemeToggle
                side="top"
                align="end"
                variant="ghost"
                className="size-7 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-svh bg-background">
      <a
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background shadow-lg transition-transform focus:translate-y-0"
        href="#main-content"
      >
        {t('Skip to content', 'Zum Inhalt springen')}
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-sidebar-border lg:block">
        {renderSidebarContent()}
      </aside>

      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden">
        <Brand />
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label={t('Open navigation', 'Navigation öffnen')}>
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[min(88vw,17rem)] gap-0 overflow-hidden border-sidebar-border bg-sidebar p-0 [&_[data-slot=sheet-close]]:z-10 [&_[data-slot=sheet-close]]:text-muted-foreground [&_[data-slot=sheet-close]]:hover:bg-sidebar-accent [&_[data-slot=sheet-close]]:hover:text-sidebar-accent-foreground"
              showCloseButton
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                window.requestAnimationFrame(() => mobileNavFirstRef.current?.focus());
              }}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Navigation</SheetTitle>
                <SheetDescription>{t(`${BRAND_NAME} main navigation`, `${BRAND_NAME} Hauptnavigation`)}</SheetDescription>
              </SheetHeader>
              {renderSidebarContent(true)}
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-[calc(100svh-3.5rem)] px-4 py-6 outline-none sm:px-6 sm:py-8 lg:ml-64 lg:min-h-svh lg:px-8"
      >
        <div className="mx-auto w-full max-w-[88rem]">
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
