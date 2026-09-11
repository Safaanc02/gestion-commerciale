'use client';

import { useState, useEffect, useRef, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLandingPage } from '@/components/layout/AuthGuard';
import { useAuthStore } from '@/store/auth';
import { PinPad } from '@/components/auth/PinPad';
import { Card, CardContent } from '@/components/ui/card';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { ROLE_LABEL_KEYS, BUSINESS_TYPE_LABEL_KEYS } from '@/lib/i18n-enums';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { loginWithPin, selectTenant, user, tenants, currentTenant, loadFromStorage } = useAuthStore();
  const { t } = useI18n();

  const [pin, setPin] = useState('');
  // Kept true: a till is a shared machine that stays signed in through a
  // shift. There is no checkbox to ask about it.
  const rememberMe = true;
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/setup/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.needsSetup) router.replace('/setup');
      })
      .catch(() => {});

    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.status !== 'ok') {
          setDbError(data.db || t('auth.dbErrorPrefix'));
        }
      })
      .catch(() => {});
  }, [router, t]);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  const handleTenantSelect = useCallback(async (tenantId: number) => {
    setLoading(true);
    try {
      await selectTenant(tenantId);
      // useEffect on currentTenant will handle the redirect
    } catch {
      toast.error(t('auth.selectBusinessFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectTenant, t]);

  const autoSelectAttempted = useRef(false);

  useEffect(() => {
    let active = true;
    if (user && currentTenant) {
      router.push(getLandingPage());
    } else if (user && tenants.length === 1 && !autoSelectAttempted.current) {
      autoSelectAttempted.current = true;
      selectTenant(tenants[0].id)
        .catch(() => { if (active) toast.error(t('auth.selectBusinessFailed')); })
        .finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [user, tenants, currentTenant, router, selectTenant, t]);

  const handleLogin = async () => {
    setLoading(true);
    setLoginError(null);
    try {
      await loginWithPin(pin, rememberMe);
      toast.success(t('auth.signInSuccess'));
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: { error?: string; attempts_remaining?: number; lockout_minutes?: number } } };
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 401) {
        const remaining = data?.attempts_remaining;
        if (remaining === 0) {
          // Just got locked out
          const mins = data?.lockout_minutes ?? 15;
          setLoginError(t('auth.lockedOut').replace('{minutes}', String(mins)));
        } else if (typeof remaining === 'number' && remaining < 4) {
          // Warn only when getting close (≤ 4 remaining to avoid noise on first attempt)
          setLoginError(
            t('auth.invalidCredentials') + ' ' +
            t('auth.attemptsRemaining').replace('{count}', String(remaining))
          );
        } else {
          setLoginError(t('auth.invalidPin'));
        }
      } else if (status === 429) {
        // Middleware-level lockout (authRateLimit window exhausted)
        const msg = data?.error || t('auth.lockedOut').replace('{minutes}', '15');
        setLoginError(msg);
      } else {
        const msg = data?.error || t('auth.loginFailed');
        setDbError(msg);
      }
    } finally {
      setLoading(false);
    }
  };



  const shouldShowTenantSelect = !!(user && (tenants.length > 1 || searchParams.get('select_tenant') === 'true'));

  if (shouldShowTenantSelect) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md">
          <Card>
            <CardContent className="pt-6">
              <h2 className="text-2xl font-bold mb-2">{t('auth.selectBusiness')}</h2>
              <p className="text-muted-foreground text-sm mb-6">{t('auth.selectBusinessHint')}</p>
              <div className="space-y-3">
                {tenants.map((tenant) => (
                  <button
                    key={tenant.id}
                    onClick={() => handleTenantSelect(tenant.id)}
                    disabled={loading}
                    className="w-full text-left p-4 border rounded-lg hover:border-primary hover:bg-accent transition-colors group"
                  >
                    <div className="font-semibold group-hover:text-primary">{tenant.business_name}</div>
                    <div className="text-sm text-muted-foreground mt-0.5">{t(BUSINESS_TYPE_LABEL_KEYS[tenant.business_type ?? ''] ?? tenant.business_type ?? '')} &middot; {t(ROLE_LABEL_KEYS[tenant.role ?? ''] ?? tenant.role ?? '')}</div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Flo" width={120} height={77} className="mx-auto mb-3" />
          <p className="text-muted-foreground mt-2">{t('auth.signInTitle')}</p>
        </div>
        {dbError && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <strong>{t('auth.dbErrorPrefix')}</strong> {dbError}
          </div>
        )}
        <Card>
          <CardContent className="pt-6">
            <div className="pt-2">
              {/* Keypad, not a form. Staff sign in between customers on a
                  touch screen; an email field and a password field is friction
                  paid on every shift, and a password long enough to be worth
                  having is one nobody types standing up. */}
              <PinPad
                value={pin}
                onChange={(next) => { setPin(next); setLoginError(null); }}
                onSubmit={handleLogin}
                canSubmit={pin.length >= 4}
                busy={loading}
                error={loginError}
                label={t('auth.enterPin')}
                submitLabel={loading ? t('auth.signingIn') : t('auth.signIn')}
              />
              <button
                type="button"
                onClick={() => router.push('/auth/recover')}
                className="mt-4 w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('auth.forgotPin')}
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
