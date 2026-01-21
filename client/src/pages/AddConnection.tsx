import { Navigate } from 'react-router-dom';

// Legacy route: kept for backwards compatibility (old nav links)
export default function AddConnection() {
  return <Navigate to="/Connections?tab=invite" replace />;
}
