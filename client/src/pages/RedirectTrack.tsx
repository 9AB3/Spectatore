import { useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { track } from '../lib/analytics';

type RedirectKey = 'linkedin' | 'instagram' | 'facebook' | 'email';

const MAP: Record<RedirectKey, { source: string; medium: string; campaign: string; content?: string }> = {
  linkedin: { source: 'linkedin', medium: 'social', campaign: 'redirect' },
  instagram: { source: 'instagram', medium: 'social', campaign: 'redirect' },
  facebook: { source: 'facebook', medium: 'social', campaign: 'redirect' },
  email: { source: 'email', medium: 'email', campaign: 'redirect' },
};

function storeAttribution(v: { source: string; medium: string; campaign: string; content?: string }) {
  try {
    sessionStorage.setItem('spectatore_attribution_v1', JSON.stringify({
      ...v,
      ts: Date.now(),
      via: 'redirect',
    }));
  } catch {}
}

export default function RedirectTrack() {
  const { key } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const k = (key || '').toLowerCase() as RedirectKey;
    const cfgBase = (MAP as any)[k] || { source: k || 'unknown', medium: 'referral', campaign: 'redirect' };

    // Optional query overrides, handy for QR codes: /r/linkedin?c=qr_jan or ?campaign=promo1
    const qp = new URLSearchParams(location.search);
    const content = qp.get('c') || qp.get('content') || qp.get('utm_content') || undefined;
    const campaign = qp.get('campaign') || qp.get('utm_campaign') || cfgBase.campaign;
    const cfg = { ...cfgBase, campaign, content: content || cfgBase.content };

    storeAttribution(cfg);

    // Fire an explicit event so you can see which redirect was used even before acquisition processing
    track.click('redirect_link', { redirect: k || 'unknown', source: cfg.source, medium: cfg.medium, campaign: cfg.campaign });

    // Redirect to clean home URL (no UTMs shown)
    navigate('/', { replace: true });
  }, [key, navigate, location.search]);

  return null;
}
