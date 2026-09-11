'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ArrowRight, Check, KeyRound, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { getCountryByCode, type Country } from '@/lib/countries';
import { t as translate, type Language } from '@/lib/i18n';
import { PinPad } from '@/components/auth/PinPad';

type SetupProfile = 'empty' | 'express' | 'demo';
type ServiceModel = 'qsr' | 'finedine';




export default function SetupPage() {
  const { logout } = useAuthStore();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showMasterPin, setShowMasterPin] = useState(false);
  const [showConfirmMasterPin, setShowConfirmMasterPin] = useState(false);
  // 'empty' — the shop's catalogue comes from its existing system, not from
  // sample data. Demo products in a live till are a trap: they get sold.
  const profile: SetupProfile = 'empty';
  // A grocery collects payment at the till, always. The value is still sent
  // and stored so it can be changed later in Settings, but it is not asked.
  const serviceModel: ServiceModel = 'qsr';
  // Darija by default: the shop floor language. Switchable here and later in
  // Settings.
  const [language, setLanguage] = useState<Language>('ar');
  // Fixed: this build is for Moroccan shops. Kept as a named constant rather
  // than inlined so the country still flows through to currency, timezone and
  // tax resolution exactly as before.
  const country = 'MA';
  const [showOtherLanguages, setShowOtherLanguages] = useState(false);
  const [form, setForm] = useState({ business_name: '' });
  const [ownerPin, setOwnerPin] = useState('');
  // null while choosing; a string once the PIN is being confirmed.
  const [ownerPinConfirm, setOwnerPinConfirm] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [masterPinAvailable, setMasterPinAvailable] = useState<boolean | null>(null);
  const [masterPin, setMasterPin] = useState('');
  const [masterPinConfirm, setMasterPinConfirm] = useState('');
  const masterPinValid = /^\d{4}$/.test(masterPin) && masterPin === masterPinConfirm;



  useEffect(() => {
    let mounted = true;
    api.get('/auth/setup/status')
      .then(({ data }) => {
        if (!mounted) return;
        setMasterPinAvailable(!!data.masterPinAvailable);
        // An owner already exists — /auth/setup/initialize is disabled server-side,
        // so bail out immediately instead of letting the user fill the whole wizard
        // and only find out at the final submit.
        if (!data.needsSetup) {
          toast.error('Setup has already been completed on this install. Redirecting to login…');
          window.location.replace('/auth/login');
        }
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        console.warn('[Setup] Failed to check setup status:', err);
        setMasterPinAvailable(false);
      });
    return () => { mounted = false; };
  }, []);

  const selectedCountry: Country | undefined = getCountryByCode(country);
  const t = (key: string) => translate(key, language);

  const completeSetup = () => {
    usePosSettingsStore.getState().setLanguage(language);
    // Persist language server-side so the standalone KDS inherits it.
    api.put(`/settings/language`, { value: language }).catch((err: unknown) => {
      console.warn('[Setup] Failed to persist language setting:', err);
    });
    logout();
    toast.success(t('setup.completeSetupSuccess'));
    window.location.replace('/auth/login');
  };

  /** The PIN must be chosen, confirmed, and the disclaimer accepted. */
  const validateOwner = () => {
    if (!/^\d{4,8}$/.test(ownerPin) || ownerPinConfirm !== ownerPin) {
      toast.error(t('setup.pinRequired'));
      return false;
    }
    if (!termsAccepted) {
      toast.error(t('setup.errorTermsRequired'));
      return false;
    }
    return true;
  };

  const handleCompleteSetup = async () => {
    if (loading) return;
    if (!validateOwner()) {
      setStep(3);
      return;
    }
    if (masterPinAvailable && !masterPinValid) {
      toast.error(t('setup.masterPinRequired'));
      setStep(2);
      return;
    }

    setLoading(true);
    try {
      const countryProfile = selectedCountry;
      const countryCode = countryProfile?.code || country;
      const countryPayload = {
        country: countryCode,
        currency: countryProfile?.currency,
        timezone: countryProfile?.timezone,
        language,
      };

      await api.post('/auth/setup/initialize', {
        owner_pin: ownerPin,
        // Grocery till, not a restaurant — see seedInstallDefaults in main/db.ts.
        business_type: 'retail',
        business_name: form.business_name || undefined,
        setup_profile: profile,
        service_model: serviceModel,
        terms_accepted: termsAccepted,
        master_pin: masterPinAvailable ? masterPin : undefined,
        // Cloud sync stays OFF. Upstream's setup registers the shop with
        // blue.flopos.com — the original vendor's servers — and its
        // zero-touch registration creates the remote store immediately. This
        // shop has no relationship with that vendor, so its sales must not
        // leave the premises. The feature is still in the code and can be
        // turned on from Settings, pointed wherever the owner chooses.
        cloud_sync_enabled: false,
        email_product_updates: false,
        email_marketing: false,
        ...countryPayload,
      });
      completeSetup();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('setup.errorGeneric'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Flo" width={80} height={52} className="mx-auto mb-4" />
          <h1 className="text-3xl font-bold">{t('setup.welcome')}</h1>
          <p className="text-muted-foreground mt-2">{t('setup.tagline')}</p>
        </div>

        <div className="flex justify-center gap-2 mb-8">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`w-3 h-3 rounded-full transition-colors ${
                s === step ? 'bg-primary' : s < step ? 'bg-primary/50' : 'bg-muted'
              }`}
            />
          ))}
        </div>

        <Card>
          <CardContent className="pt-6">
            {step === 1 && (
              <div className="space-y-6">
                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.chooseLanguage')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.chooseLanguageHint')}</p>
                </div>

                {/* Two languages, side by side, nothing to scroll.
                    The country picker that used to sit under this is gone: this
                    build is for Moroccan shops, so the country is Morocco. It
                    was a list of 35 countries asked once and never revisited,
                    with a wrong answer silently setting the wrong currency and
                    tax rules. */}
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['ar', 'fr'] as const).map((option) => {
                    const selected = language === option;
                    return (
                      <button
                        key={option}
                        onClick={() => setLanguage(option)}
                        dir={option === 'ar' ? 'rtl' : 'ltr'}
                        className={`p-6 rounded-xl border-2 transition-all ${
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:border-input'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-start">
                            <div className="text-xl font-semibold">
                              {option === 'ar' ? 'الدارجة' : 'Français'}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {option === 'ar' ? 'المغربية' : 'Maroc'}
                            </div>
                          </div>
                          {selected && <Check className="w-5 h-5 text-primary shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => setShowOtherLanguages((v) => !v)}
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('setup.otherLanguages')}
                </button>

                {showOtherLanguages && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(['en', 'es', 'pt'] as const).map((option) => {
                      const selected = language === option;
                      const label = option === 'es' ? t('setup.languageSpanish')
                        : option === 'pt' ? t('setup.languagePortuguese')
                          : t('setup.languageEnglish');
                      return (
                        <button
                          key={option}
                          onClick={() => setLanguage(option)}
                          className={`p-3 rounded-lg border-2 text-sm transition-all ${
                            selected ? 'border-primary bg-primary/5' : 'border-border hover:border-input'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}

                <Button onClick={() => setStep(2)} className="w-full" size="lg">
                  {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(1)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                    <KeyRound className="w-5 h-5 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold mb-2">{t('setup.setMasterPinTitle')}</h2>
                  <p className="text-muted-foreground text-sm">
                    {t('setup.setMasterPinDescription')}
                  </p>
                  <p className="text-muted-foreground text-xs mt-2 bg-muted rounded-lg p-3">
                    {t('setup.masterPinRecoveryNote')}
                  </p>
                </div>

                {masterPinAvailable === false ? (
                  <p className="text-sm text-center text-muted-foreground bg-muted rounded-lg p-4">
                    {t('setup.masterPinNotAvailable')}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="master-pin">{t('setup.pinLabel')}</Label>
                      <div className="relative">
                        <Input
                          id="master-pin"
                          type={showMasterPin ? "text" : "password"}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={masterPin}
                          onChange={(e) => setMasterPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="text-center text-lg tracking-[0.5em] pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowMasterPin(!showMasterPin)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showMasterPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="master-pin-confirm">{t('setup.confirmPinLabel')}</Label>
                      <div className="relative">
                        <Input
                          id="master-pin-confirm"
                          type={showConfirmMasterPin ? "text" : "password"}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={4}
                          value={masterPinConfirm}
                          onChange={(e) => setMasterPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          className="text-center text-lg tracking-[0.5em] pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmMasterPin(!showConfirmMasterPin)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                          tabIndex={-1}
                        >
                          {showConfirmMasterPin ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <Button
                  onClick={() => setStep(3)}
                  disabled={masterPinAvailable === true && !masterPinValid}
                  className="w-full"
                  size="lg"
                >
                  {t('setup.continue')} <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(2)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.ownerPinTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.ownerPinSubtitle')}</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="shop-name">{t('setup.businessName')}</Label>
                  <Input
                    id="shop-name"
                    value={form.business_name}
                    onChange={(e) => setForm({ ...form, business_name: e.target.value })}
                    placeholder={t('setup.businessNamePlaceholder')}
                  />
                </div>

                {/* No account to create: the owner picks a PIN, twice. There is
                    no email to verify, no password rules to explain, and
                    nothing to recover through a mailbox the shop may not have. */}
                <PinPad
                  value={ownerPinConfirm === null ? ownerPin : ownerPinConfirm}
                  onChange={(next: string) => {
                    setPinError(null);
                    if (ownerPinConfirm === null) setOwnerPin(next);
                    else setOwnerPinConfirm(next);
                  }}
                  onSubmit={() => {
                    setPinError(null);
                    if (ownerPinConfirm === null) {
                      if (ownerPin.length < 4) return;
                      setOwnerPinConfirm('');
                      return;
                    }
                    if (ownerPinConfirm !== ownerPin) {
                      // Cleared rather than corrected: a mistyped PIN chosen
                      // here locks the shop out of its own till on Monday.
                      setPinError(t('setup.pinMismatch'));
                      setOwnerPin('');
                      setOwnerPinConfirm(null);
                      return;
                    }
                    setStep(4);
                  }}
                  canSubmit={(ownerPinConfirm === null ? ownerPin : ownerPinConfirm).length >= 4}
                  error={pinError}
                  label={ownerPinConfirm === null ? t('setup.pinChoose') : t('setup.pinConfirm')}
                  submitLabel={ownerPinConfirm === null ? t('setup.continue') : t('setup.pinValidate')}
                />

                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-input"
                  />
                  <span>{t('setup.disclaimer')}</span>
                </label>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-6">
                <button
                  onClick={() => setStep(3)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" /> {t('setup.back')}
                </button>

                <div className="text-center">
                  <h2 className="text-xl font-semibold mb-2">{t('setup.flowTitle')}</h2>
                  <p className="text-muted-foreground text-sm">{t('setup.flowSubtitle')}</p>
                </div>

                {/* No service-model choice here.
                    Upstream asks whether the outlet is quick-service or
                    table-service, which decides when payment is collected. A
                    grocery has only one answer — the customer pays at the till
                    before leaving — so the question is friction, and the
                    prepaid model is simply used. The setting still exists and
                    can be changed later in Settings for anyone who needs it. */}
                <div className="rounded-xl border bg-muted/30 p-5 text-sm text-muted-foreground">
                  <ul className="space-y-2">
                    <li className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{t('setup.readyScan')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{t('setup.readyWeigh')}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{t('setup.readyPrint')}</span>
                    </li>
                  </ul>
                </div>

                <Button onClick={handleCompleteSetup} disabled={loading} className="w-full" size="lg">
                  {loading ? t('setup.completingSetup') : (
                    <>
                      {t('setup.completeSetup')} <ArrowRight className="w-4 h-4 ml-2" />
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
