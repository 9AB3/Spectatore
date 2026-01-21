import { Navigate, useLocation } from 'react-router-dom';

// Legacy route: kept for backwards compatibility (old bookmarks)
export default function ViewConnections() {
  const loc = useLocation();
  const sp = new URLSearchParams(loc.search);
  const tab = (sp.get('tab') || '').toLowerCase();
  const next = tab === 'incoming' ? 'incoming' : tab === 'outgoing' ? 'outgoing' : 'crew';
  return <Navigate to={`/Connections?tab=${next}`} replace />;
}
