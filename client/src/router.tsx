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
import ClearShifts from './pages/ClearShifts';
import ClearData from './pages/ClearData';
import AddConnection from './pages/AddConnection';
import ViewConnections from './pages/ViewConnections';
import AdminUsers from './pages/AdminUsers';
import Settings from './pages/Settings';
import { useEffect, useState } from 'react';
import { getDB } from './lib/idb';
import ProtectedLayout from './components/ProtectedLayout';

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
        element={
          <RequireAuth>
            <ProtectedLayout />
          </RequireAuth>
        }
      >
        <Route path="/Main" element={<Main />} />
        <Route path="/Shift" element={<Shift />} />
        <Route path="/Activity" element={<Activity />} />
        <Route path="/ViewActivities" element={<ViewActivities />} />
        <Route path="/FinalizeShift" element={<FinalizeShift />} />

        <Route path="/Connections" element={<Connections />} />
        <Route path="/Equipment&Locations" element={<EquipmentLocations />} />
        <Route path="/PerformanceReview" element={<PerformanceReview />} />
        <Route path="/Settings" element={<Settings />} />

        <Route path="/ClearShifts" element={<ClearShifts />} />
        <Route path="/AddConnection" element={<AddConnection />} />
        <Route path="/ViewConnections" element={<ViewConnections />} />
        <Route path="/AdminUsers" element={<AdminUsers />} />
      </Route>

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
