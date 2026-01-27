// Lightweight GA4 helper for Spectatore (SPA/PWA friendly)
// Measurement ID can be set via VITE_GA_MEASUREMENT_ID in Render env vars.
// Fallback is safe to ship (GA Measurement IDs are not secrets).

declare global {
  interface Window {
    dataLayer?: any[];
    gtag?: (...args: any[]) => void;
  }
}

const DEFAULT_MEASUREMENT_ID = 'G-Z7X38HRNDZ';

let _inited = false;
let _mid = '';

function injectGtag(mid: string) {
  // Avoid duplicate injection
  const existing = document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
  if (!existing) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(mid)}`;
    document.head.appendChild(s);
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag(){ window.dataLayer!.push(arguments); };

  // Initialize
  window.gtag('js', new Date());
  // IMPORTANT for SPA: we will send page_view manually on route changes
  window.gtag('config', mid, { send_page_view: false });
}

export function initAnalytics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (_inited) return;

  const envMid = String((import.meta as any).env?.VITE_GA_MEASUREMENT_ID || '').trim();
  const mid = envMid || DEFAULT_MEASUREMENT_ID;

  // Allow disabling by setting VITE_GA_DISABLED=1
  const disabled = String((import.meta as any).env?.VITE_GA_DISABLED || '') === '1';
  if (disabled || !mid) return;

  _mid = mid;
  injectGtag(mid);
  _inited = true;
}

export function gaPageView(pathnameWithQuery?: string) {
  if (!_inited || !window.gtag) return;
  const page_location = typeof window !== 'undefined' ? window.location.href : undefined;
  const page_path = pathnameWithQuery || (typeof window !== 'undefined' ? (window.location.pathname + window.location.search) : undefined);
  window.gtag('event', 'page_view', {
    page_location,
    page_path,
  });
}

function gaEvent(name: string, params?: Record<string, any>) {
  if (!_inited || !window.gtag) return;
  window.gtag('event', name, params || {});
}

export const track = {
  // Funnel
  signupStart(source?: string) {
    gaEvent('sign_up_start', { source: source || 'unknown' });
  },
  signupComplete(method?: string) {
    // GA4 has a recommended event name "sign_up"
    gaEvent('sign_up', { method: method || 'unknown' });
  },

  // Stripe-ready (wire these when you add Stripe)
  beginCheckout(price_id?: string) {
    gaEvent('begin_checkout', { price_id });
  },
  purchase(price_id?: string, value?: number, currency: string = 'AUD') {
    gaEvent('purchase', { price_id, value, currency });
  },

  // Core Spectatore actions
  startShift() {
    gaEvent('start_shift');
  },
  tagOut() {
    gaEvent('tag_out');
  },
  finalizeShift() {
    gaEvent('finalize_shift');
  },
  feedbackOpen(source?: string) {
    gaEvent('feedback_open', { source: source || 'unknown' });
  },
  openYouVsYou() {
    gaEvent('open_you_vs_you');
  },
  openYouVsCrew() {
    gaEvent('open_you_vs_crew');
  },
  openCommunity() {
    gaEvent('open_community');
  },

  click(name: string, extra?: Record<string, any>) {
    gaEvent('ui_click', { name, ...(extra || {}) });
  },
  videoPlay(name: string, extra?: Record<string, any>) {
    gaEvent('video_play', { name, ...(extra || {}) });
  },
};
