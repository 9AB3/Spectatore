import { Routes, Route, Navigate, Link } from 'react-router-dom';
import Home from './pages/Home';
import Main from './pages/Main';
import Shift from './pages/Shift';
import Activity from './pages/Activity';
import ViewActivities from './pages/ViewActivities';
import FinalizeShift from './pages/FinalizeShift';
import Connections from './pages/Connections';
import Register from './pages/Register';
import ConfirmEmail from './pages/ConfirmEmail';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import EquipmentLocations from './pages/EquipmentLocations';
import PerformanceReview from './pages/PerformanceReview';
import ClearData from './pages/ClearData';
import AddConnection from './pages/AddConnection';
import ViewConnections from './pages/ViewConnections';
import AdminUsers from './pages/AdminUsers';
import { useEffect, useState } from 'react';
import { getDB } from './lib/idb';

function RequireAuth({ children }: { children: JSX.Element }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const session = await db.get('session', 'auth');
      setOk(!!session?.token);
    })();
  }, []);
  if (ok === null) return null;
  return ok ? children : <Navigate to="/Home" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/Home" />} />
      {/* Public */}
      <Route path="/Home" element={<Home />} />
      <Route path="/Register" element={<Register />} />
      <Route path="/ConfirmEmail" element={<ConfirmEmail />} />
      <Route path="/ForgotPassword" element={<ForgotPassword />} />
      <Route path="/ResetPassword" element={<ResetPassword />} />

      {/* Protected */}
      <Route
        path="/Main"
        element={
          <RequireAuth>
            <Main />
          </RequireAuth>
        }
      />
      <Route
        path="/Shift"
        element={
          <RequireAuth>
            <Shift />
          </RequireAuth>
        }
      />
      <Route
        path="/Activity"
        element={
          <RequireAuth>
            <Activity />
          </RequireAuth>
        }
      />
      <Route
        path="/ViewActivities"
        element={
          <RequireAuth>
            <ViewActivities />
          </RequireAuth>
        }
      />
      <Route
        path="/FinalizeShift"
        element={
          <RequireAuth>
            <FinalizeShift />
          </RequireAuth>
        }
      />
      <Route
        path="/Connections"
        element={
          <RequireAuth>
            <Connections />
          </RequireAuth>
        }
      />
      <Route
        path="/Equipment&Locations"
        element={
          <RequireAuth>
            <EquipmentLocations />
          </RequireAuth>
        }
      />
      <Route
        path="/PerformanceReview"
        element={
          <RequireAuth>
            <PerformanceReview />
          </RequireAuth>
        }
      />
      <Route
        path="/AddConnection"
        element={
          <RequireAuth>
            <AddConnection />
          </RequireAuth>
        }
      />
      <Route
        path="/ViewConnections"
        element={
          <RequireAuth>
            <ViewConnections />
          </RequireAuth>
        }
      />
      <Route
        path="/AdminUsers"
        element={
          <RequireAuth>
            <AdminUsers />
          </RequireAuth>
        }
      />

      <Route
        path="*"
        element={
          <div className="p-6">
            Not Found.{' '}
            <Link to="/Home" className="text-sky-600">
              Home
            </Link>
          </div>
        }
      />
      <Route path="/tools/clear" element={<ClearData />} />
    </Routes>
  );
}
