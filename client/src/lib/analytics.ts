// Lightweight GA4 helper for Spectatore (SPA/PWA friendly)
// Measurement ID can be set via VITE_GA_MEASUREMENT_ID in Render env vars.
// Fallback is safe to ship (GA Measurement IDs are not secrets).

declare global {
  interface Window {
    dataLayer?: any[];
    gtag?: (...args: any[]) => void;
  }
}

const DEFAULT_MEASUREMENT_ID = 'G-K3B0KNBQ6T';

let _inited = false;
let _mid = '';


function isDebugMode() {
  try {
    const qs = typeof window !== 'undefined' ? window.location.search : '';
    const p = new URLSearchParams(qs);
    if (p.get('debug_mode') === 'true' || p.get('debug') === '1') return true;
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem('spectatore_ga_debug') === '1';
    }
  } catch {}
  return false;
}



function readAttribution() {
  try {
    // Prefer session-scoped attribution (redirect links / UTMs on entry)
    const raw = sessionStorage.getItem('spectatore_attribution_v1');
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return v as any;
  } catch {
    return null;
  }
}

function captureUtmToAttribution() {
  try {
    const p = new URLSearchParams(window.location.search);
    const utm_source = p.get('utm_source') || undefined;
    const utm_medium = p.get('utm_medium') || undefined;
    const utm_campaign = p.get('utm_campaign') || undefined;
    const utm_content = p.get('utm_content') || undefined;

    // If no UTMs, do nothing
    if (!utm_source && !utm_medium && !utm_campaign && !utm_content) return;

    // Store for this tab/session (so later SPA navigations keep attribution)
    sessionStorage.setItem(
      'spectatore_attribution_v1',
      JSON.stringify({
        source: utm_source,
        medium: utm_medium,
        campaign: utm_campaign,
        content: utm_content,
        ts: Date.now(),
        via: 'utm',
      }),
    );

    // Optional: clean the address bar (keep history clean) AFTER we capture it.
    // We only remove known UTM/debug params; we keep other query params intact.
    const toDelete = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id','gclid','fbclid','msclkid','debug_mode','debug'];
    let changed = false;
    for (const k of toDelete) {
      if (p.has(k)) { p.delete(k); changed = true; }
    }
    if (changed) {
      const newQs = p.toString();
      const newUrl = window.location.pathname + (newQs ? `?${newQs}` : '') + window.location.hash;
      window.history.replaceState({}, document.title, newUrl);
    }
  } catch {}
}

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
  window.gtag('config', mid, { send_page_view: false, debug_mode: isDebugMode() });
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
  captureUtmToAttribution();
  injectGtag(mid);
  _inited = true;
}

export function gaPageView(pathnameWithQuery?: string) {
  if (!_inited || !window.gtag) return;
  const page_location = typeof window !== 'undefined' ? window.location.href : undefined;
  const attrib = readAttribution();
  const page_path = pathnameWithQuery || (typeof window !== 'undefined' ? (window.location.pathname + window.location.search) : undefined);
  window.gtag('event', 'page_view', {
    page_location,
    page_path,
    source: attrib?.source,
    medium: attrib?.medium,
    campaign: attrib?.campaign,
    content: attrib?.content,
    debug_mode: isDebugMode(),
  });
}

function safeNavigate(href: string) {
  try {
    window.location.assign(href);
  } catch {
    // Fallback
    (window.location as any).href = href;
  }
}

function gaEvent(
  name: string,
  params?: Record<string, any>,
  opts?: { callback?: () => void; timeoutMs?: number },
) {
  if (!_inited || !window.gtag) {
    // If analytics isn't ready but a callback is requested, still proceed.
    if (opts?.callback) opts.callback();
    return;
  }

  const callback = opts?.callback;
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts!.timeoutMs : 800;

  // Ensure debug traffic is visible in GA4 DebugView when requested
  const attrib = readAttribution();
  const mergedParams = { ...(params || {}), debug_mode: isDebugMode(), source: attrib?.source, medium: attrib?.medium, campaign: attrib?.campaign, content: attrib?.content };

  if (callback) {
    // GA4 supports event_callback + event_timeout to improve reliability for outbound links.
    window.gtag('event', name, {
      ...mergedParams,
      event_callback: callback,
      event_timeout: timeoutMs,
    });
  } else {
    window.gtag('event', name, mergedParams);
  }
}

export const track = {
  // Funnel
  signupStart(source?: string) {
    gaEvent('sign_up_start', { source: source || 'unknown' });
  },
  signupStartNavigate(source: string | undefined, href: string) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      safeNavigate(href);
    };
    gaEvent('sign_up_start', { source: source || 'unknown' }, { callback: go, timeoutMs: 800 });
    window.setTimeout(go, 900);
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
  clickNavigate(name: string, href: string, extra?: Record<string, any>) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      safeNavigate(href);
    };
    // Fire event and navigate once GA confirms, with a hard fallback timeout.
    gaEvent('ui_click', { name, ...(extra || {}) }, { callback: go, timeoutMs: 800 });
    window.setTimeout(go, 900);
  },
  videoPlay(name: string, extra?: Record<string, any>) {
    gaEvent('video_play', { name, ...(extra || {}) });
  },
};
