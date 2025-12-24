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
import YouVsYou from './pages/YouVsYou';
import YouVsNetwork from './pages/YouVsNetwork';
import ClearShifts from './pages/ClearShifts';
import ClearData from './pages/ClearData';
import AddConnection from './pages/AddConnection';
import ViewConnections from './pages/ViewConnections';
import AdminUsers from './pages/AdminUsers';
import Settings from './pages/Settings';
import Feedback from './pages/Feedback';
import Notifications from './pages/Notifications';
import SiteAdminLogin from './pages/SiteAdminLogin';
import SiteAdmin from './pages/SiteAdmin';
import SiteAdminValidate from './pages/SiteAdminValidate';
import SiteAdminEquipmentLocations from './pages/SiteAdminEquipmentLocations';
import SiteAdminCreateSite from './pages/SiteAdminCreateSite';
import SiteAdminCreateSiteAdministrators from './pages/SiteAdminCreateSiteAdministrators';
import SiteAdminMenu from './pages/SiteAdminMenu';
import SiteAdminLayout from './components/SiteAdminLayout';
import SiteAdminSites from './pages/SiteAdminSites';
import SiteAdminSiteAdmins from './pages/SiteAdminSiteAdmins';
import SiteAdminFeedbackApproval from './pages/SiteAdminFeedbackApproval';
import SiteAdminSeed from './pages/SiteAdminSeed';
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

function RequireSiteAdmin({ children }: { children: JSX.Element }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const sa = await db.get('session', 'site_admin');
      if (sa?.token) return setOk(true);
      const auth = await db.get('session', 'auth');
      setOk(!!auth?.token && !!auth?.is_admin);
    })();
  }, []);
  if (ok === null) return null;
  return ok ? children : <Navigate to="/SiteAdminLogin" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/Home" />} />
      {/* Public */}
      <Route path="/Home" element={<Home />} />
      <Route path="/SiteAdminLogin" element={<SiteAdminLogin />} />
      <Route path="/Register" element={<Register />} />
      <Route path="/ConfirmEmail" element={<ConfirmEmail />} />
      <Route path="/ForgotPassword" element={<ForgotPassword />} />
      <Route path="/ResetPassword" element={<ResetPassword />} />

      {/* Site Admin (layout + bottom nav) */}
      <Route
        path="/SiteAdmin"
        element={
          <RequireSiteAdmin>
            <SiteAdminLayout />
          </RequireSiteAdmin>
        }
      >
        <Route index element={<SiteAdmin />} />
        <Route path="Validate" element={<SiteAdminValidate />} />
        <Route path="Equipment&Locations" element={<SiteAdminEquipmentLocations />} />
        <Route path="Sites" element={<SiteAdminSites />} />
        <Route path="SiteAdmins" element={<SiteAdminSiteAdmins />} />
        <Route path="ApproveFeedback" element={<SiteAdminFeedbackApproval />} />
        <Route path="Seed" element={<SiteAdminSeed />} />
        <Route path="Edit" element={<div className="p-6">Coming soon</div>} />
        <Route path="Export" element={<div className="p-6">Coming soon</div>} />

        {/* Backwards-compatible routes */}
        <Route path="CreateSite" element={<Navigate to="/SiteAdmin/Sites" replace />} />
        <Route
          path="CreateSiteAdministrators"
          element={<Navigate to="/SiteAdmin/SiteAdmins" replace />}
        />
        <Route path="Menu" element={<SiteAdminMenu />} />
      </Route>

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
        <Route path="/YouVsYou" element={<YouVsYou />} />
        <Route path="/YouVsNetwork" element={<YouVsNetwork />} />
        <Route path="/Settings" element={<Settings />} />
        <Route path="/Feedback" element={<Feedback />} />
        <Route path="/Notifications" element={<Notifications />} />

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
