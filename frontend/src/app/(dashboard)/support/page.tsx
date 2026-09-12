'use client';

import { Mail, Phone } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

/**
 * Who to call when something goes wrong.
 *
 * This screen used to be a ticket form. It posted to the cloud server of the
 * project this software was forked from — carrying the shop's name, its
 * machine name and whatever the cashier typed — where nobody was ever going to
 * read it. A support button that quietly sends a cry for help to a stranger is
 * worse than no support button.
 *
 * The shop is supported by one person, reachable on a phone. That is what the
 * screen says now, and both lines are tappable: on a till with a touch screen
 * and no keyboard, copying a number by hand is exactly the friction you do not
 * want from somebody already having a bad day.
 */
const CONTACT = {
  phone: '+212 658602622',
  // tel: needs the number without spaces
  phoneDial: '+212658602622',
  email: 'ncirisafaaa@gmail.com',
};

export default function SupportPage() {
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-bold text-foreground">{t('nav.support')}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{t('support.contactHint')}</p>

      <div className="flex flex-col gap-3">
        <a
          href={`tel:${CONTACT.phoneDial}`}
          className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Phone size={20} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('support.byPhone')}
            </span>
            {/* Latin digits either way: a phone number read aloud or typed into
                a handset is not translated. */}
            <span dir="ltr" className="text-lg font-semibold tabular-nums text-foreground">
              {CONTACT.phone}
            </span>
          </span>
        </a>

        <a
          href={`mailto:${CONTACT.email}`}
          className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <Mail size={20} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('support.byEmail')}
            </span>
            <span dir="ltr" className="truncate text-lg font-semibold text-foreground">
              {CONTACT.email}
            </span>
          </span>
        </a>
      </div>

      <div className="mt-6 rounded-lg border-s-[3px] border-brand bg-muted/60 p-4">
        <p className="text-sm text-foreground">{t('support.whatToSay')}</p>
      </div>
    </div>
  );
}
