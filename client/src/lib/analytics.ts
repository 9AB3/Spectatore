// Lightweight GA4 helper for Spectatore (SPA/PWA friendly)
// Measurement ID can be set via VITE_GA_MEASUREMENT_ID in Render/Vercel env vars.
// GA Measurement IDs are not secrets.
//
// Goals:
// - SPA-safe page_view tracking (manual route change calls)
// - Persist and attach UTM attribution to page_view + key events
// - Enable GA4 DebugView when ?debug_mode=true is present (or when VITE_GA_DEBUG=1)

declare global {
  interface Window {
    dataLayer?: any[];
    gtag?: (...args: any[]) => void;
  }
}

const DEFAULT_MEASUREMENT_ID = 'G-K3B0KNBQ6T';
const ATTR_KEY = 'spectatore_attribution_v1';

let _inited = false;
let _mid = '';
let _debug = false;
let _attrib: Record<string, any> = {};

/** Extract UTM/click IDs from current URL */
function readAttributionFromUrl(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const p = new URLSearchParams(window.location.search);

  const take = (k: string) => {
    const v = p.get(k);
    return v && String(v).trim() ? String(v).trim() : undefined;
  };

  const out: Record<string, string> = {};
  // Standard UTMs
  const utm_source = take('utm_source');
  const utm_medium = take('utm_medium');
  const utm_campaign = take('utm_campaign');
  const utm_content = take('utm_content');
  const utm_term = take('utm_term');

  if (utm_source) out.utm_source = utm_source;
  if (utm_medium) out.utm_medium = utm_medium;
  if (utm_campaign) out.utm_campaign = utm_campaign;
  if (utm_content) out.utm_content = utm_content;
  if (utm_term) out.utm_term = utm_term;

  // Common ad click IDs (useful for later)
  const gclid = take('gclid');
  const fbclid = take('fbclid');
  const msclkid = take('msclkid');

  if (gclid) out.gclid = gclid;
  if (fbclid) out.fbclid = fbclid;
  if (msclkid) out.msclkid = msclkid;

  return out;
}

function loadAttribFromStorage(): Record<string, any> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(ATTR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAttribToStorage(obj: Record<string, any>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ATTR_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

/**
 * Decide what attribution to keep:
 * - If URL contains UTMs/click IDs, treat that as the current entry attribution and persist it.
 * - Otherwise, fall back to persisted attribution (if any).
 */
function initAttribution() {
  const fromUrl = readAttributionFromUrl();
  const stored = loadAttribFromStorage();

  // If URL has new attribution, prefer it and store (first-touch-ish, but you can change this later)
  const hasNew = Object.keys(fromUrl).length > 0;
  const merged = hasNew ? { ...stored, ...fromUrl, first_seen_at: stored.first_seen_at || new Date().toISOString() } : stored;

  if (hasNew) {
    merged.last_seen_at = new Date().toISOString();
    saveAttribToStorage(merged);
  }

  _attrib = merged || {};
}

function computeDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  const p = new URLSearchParams(window.location.search);
  if (p.get('debug_mode') === 'true' || p.get('debug') === '1') return true;
  // Allow enabling via env var for dev builds
  const envDebug = String((import.meta as any).env?.VITE_GA_DEBUG || '').trim();
  if (envDebug === '1' || envDebug.toLowerCase() === 'true') return true;
  return false;
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

  // Enable DebugView if requested
  if (_debug) {
    // GA4 DebugView recognizes debug_mode on config/events
    window.gtag('set', 'debug_mode', true);
  }

  // IMPORTANT for SPA: we will send page_view manually on route changes
  window.gtag('config', mid, {
    send_page_view: false,
    ...( _debug ? { debug_mode: true } : {} ),
  });
}

export function initAnalytics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (_inited) return;

  const envMid = String((import.meta as any).env?.VITE_GA_MEASUREMENT_ID || '').trim();
  const mid = envMid || DEFAULT_MEASUREMENT_ID;

  // Allow disabling by setting VITE_GA_DISABLED=1
  const disabled = String((import.meta as any).env?.VITE_GA_DISABLED || '') === '1';
  if (disabled || !mid) return;

  _debug = computeDebugMode();
  initAttribution();

  _mid = mid;
  injectGtag(mid);
  _inited = true;
}

function campaignParams(): Record<string, any> {
  // Only include if present so we don't clutter event payloads
  const out: Record<string, any> = {};
  const keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','msclkid'];
  for (const k of keys) {
    const v = (_attrib as any)?.[k];
    if (v) out[k] = v;
  }
  if (_debug) out.debug_mode = true;
  return out;
}

export function gaPageView(pathnameWithQuery?: string) {
  if (!_inited || !window.gtag) return;
  const page_location = typeof window !== 'undefined' ? window.location.href : undefined;
  const page_path =
    pathnameWithQuery ||
    (typeof window !== 'undefined' ? (window.location.pathname + window.location.search) : undefined);

  window.gtag('event', 'page_view', {
    page_location,
    page_path,
    ...campaignParams(),
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

  const payload = {
    ...campaignParams(),
    ...(params || {}),
  };

  if (callback) {
    // GA4 supports event_callback + event_timeout to improve reliability for outbound links.
    window.gtag('event', name, {
      ...payload,
      event_callback: callback,
      event_timeout: timeoutMs,
    });
  } else {
    window.gtag('event', name, payload);
  }
}

/**
 * Helper for outbound links: append the stored UTMs so spectatore.com -> app.spectatore.com keeps attribution.
 */
export function withAttribution(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    const cp = campaignParams();
    // don't propagate debug_mode unless it was explicitly set via URL
    const p = u.searchParams;
    for (const k of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','msclkid']) {
      const v = (cp as any)[k];
      if (v && !p.get(k)) p.set(k, String(v));
    }
    return u.toString();
  } catch {
    return url;
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
      safeNavigate(withAttribution(href));
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

  // Generic UI helpers (landing / how-to / navigation)
  click(label: string, extra?: Record<string, any>) {
    gaEvent('ui_click', { label, ...(extra || {}) });
  },
  clickNavigate(label: string, href: string) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      safeNavigate(withAttribution(href));
    };
    gaEvent('ui_click', { label, href }, { callback: go, timeoutMs: 800 });
    window.setTimeout(go, 900);
  },
  videoPlay(id: string) {
    gaEvent('video_play', { id });
  },

  // Page opens (useful for landing-style pages that are part of the SPA)
  openCommunity() {
    gaEvent('page_open', { page: 'community' });
  },
  openYouVsCrew() {
    gaEvent('page_open', { page: 'you_vs_crew' });
  },
  openYouVsYou() {
    gaEvent('page_open', { page: 'you_vs_you' });
  },
};
