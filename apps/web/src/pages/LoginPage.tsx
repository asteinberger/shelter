import { type FormEvent, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, ShieldCheck } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, setCsrfToken } from '../api/client';
import { Brand } from '../components/Brand';
import { Button, Field } from '../components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LanguageToggle } from '@/components/LanguageToggle';
import { useI18n } from '@/i18n';
import type { Session } from '../types';
import { BRAND_NAME } from '../lib/brand';

export function LoginPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    document.title = `${t('Sign in', 'Anmelden')} · ${BRAND_NAME}`;
  }, [t]);

  const login = useMutation({
    mutationFn: () => api.login({ email: email.trim(), password }),
    onSuccess: async (session) => {
      if (session?.user) {
        setCsrfToken(session.csrfToken);
        queryClient.setQueryData<Session>(['session'], session);
      } else {
        await queryClient.invalidateQueries({ queryKey: ['session'] });
      }
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    login.mutate();
  }

  return (
    <main className="relative grid min-h-svh place-items-center bg-muted/30 px-4 py-16 sm:px-6" aria-labelledby="login-title">
      <div className="absolute top-4 right-4 flex items-center gap-2 sm:top-6 sm:right-6">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Brand linkTo="/login" showClaim />
        </div>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              <h1 id="login-title">{t('Sign in', 'Anmelden')}</h1>
            </CardTitle>
            <CardDescription>
              {t('Sign in with your Shelter administrator account.', 'Melde dich mit deinem Shelter-Admin-Konto an.')}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form className="grid gap-5" onSubmit={submit}>
              <div className="grid gap-4">
                <Field
                  label={t('Email address', 'E-Mail-Adresse')}
                  name="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => {
                    if (login.isError) login.reset();
                    setEmail(event.target.value);
                  }}
                  placeholder="admin@example.com"
                  disabled={login.isPending}
                  required
                  autoFocus
                />
                <Field
                  label={t('Password', 'Passwort')}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    if (login.isError) login.reset();
                    setPassword(event.target.value);
                  }}
                  placeholder={t('Your password', 'Dein Passwort')}
                  disabled={login.isPending}
                  required
                />
              </div>

              {login.isError && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{t('Sign-in failed', 'Anmeldung fehlgeschlagen')}</AlertTitle>
                  <AlertDescription>
                    {login.error instanceof Error ? login.error.message : t(
                      'The email address or password could not be verified.',
                      'E-Mail-Adresse oder Passwort konnten nicht bestätigt werden.',
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                size="lg"
                className="h-11 w-full"
                loading={login.isPending}
                disabled={!email.trim() || !password}
              >
                {login.isPending ? t('Signing in …', 'Anmeldung läuft …') : t('Sign in', 'Anmelden')}
                {!login.isPending && <ArrowRight aria-hidden="true" />}
              </Button>
            </form>

            <p className="mt-6 flex items-center justify-center gap-2 border-t pt-5 text-center text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t('Encrypted connection to your installation', 'Verschlüsselte Verbindung zu deiner Installation')}
            </p>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">{t('Self-hosted deployment management', 'Self-hosted Deployment-Verwaltung')}</p>
      </div>
    </main>
  );
}
