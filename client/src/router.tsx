import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { gaPageView } from './lib/analytics';
import Landing from './pages/Landing';
import RedirectTrack from './pages/RedirectTrack';
import HowTo from './pages/HowTo';
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
import YouVsYou from './pages/YouVsYou';
import YouVsNetwork from './pages/YouVsNetwork';
import YouHub from './pages/YouHub';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import ClearShifts from './pages/ClearShifts';
import ClearData from './pages/ClearData';
import AddConnection from './pages/AddConnection';
import ViewConnections from './pages/ViewConnections';
import AdminUsers from './pages/AdminUsers';
import Settings from './pages/Settings';
import Subscribe from './pages/Subscribe';
import Subscription from './pages/Subscription';
import NotificationPreferences from './pages/NotificationPreferences';

import Feedback from './pages/Feedback';
import Notifications from './pages/Notifications';
import Community from './pages/Community';
import SiteAdminLogin from './pages/SiteAdminLogin';
import SiteAdmin from './pages/SiteAdmin';
import SiteAdminValidate from './pages/SiteAdminValidate';
import SiteAdminAddActivity from './pages/SiteAdminAddActivity';
import SiteAdminEquipmentLocations from './pages/SiteAdminEquipmentLocations';
import SiteAdminMenu from './pages/SiteAdminMenu';
import SiteAdminLayout from './components/SiteAdminLayout';
import SiteAdminSites from './pages/SiteAdminSites';
import SiteAdminPeople from './pages/SiteAdminPeople';
import SiteAdminFeedbackApproval from './pages/SiteAdminFeedbackApproval';
import SiteAdminSeed from './pages/SiteAdminSeed';
import SiteAdminReconciliation from './pages/SiteAdminReconciliation';
import SiteAdminPowerBiTokens from './pages/SiteAdminPowerBiTokens';
import SiteAdminEngagement from './pages/SiteAdminEngagement';
import SiteAdminSupportSnapshot from './pages/SiteAdminSupportSnapshot';
import StartupSplash from './components/StartupSplash';
import { useEffect, useState } from 'react';
import { getDB } from './lib/idb';
import ProtectedLayout from './components/ProtectedLayout';
import { api } from './lib/api';

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
      const auth = await db.get('session', 'auth');
      if (!auth?.token) return setOk(false);
      // Server is the only source of truth for SiteAdmin authorization.
      try {
        const r: any = await api('/api/site-admin/me');
        setOk(!!r?.ok);
      } catch {
        setOk(false);
      }
    })();
  }, []);
  if (ok === null) return null;
  return ok ? children : <Navigate to="/SiteAdminLogin" replace />;
}


function RequireSiteAdminManage({ children }: { children: JSX.Element }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const auth = await db.get('session', 'auth');
      if (!auth?.token) return setOk(false);
      try {
        const r: any = await api('/api/site-admin/me');
        setOk(!!r?.ok && (!!r?.can_manage || !!r?.is_super));
      } catch {
        setOk(false);
      }
    })();
  }, []);
  if (ok === null) return null;
  return ok ? children : <Navigate to="/SiteAdmin" replace />;
}

function RequireSiteAdminSuper({ children }: { children: JSX.Element }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    (async () => {
      const db = await getDB();
      const auth = await db.get('session', 'auth');
      if (!auth?.token) return setOk(false);
      try {
        const r: any = await api('/api/site-admin/me');
        setOk(!!r?.ok && !!r?.is_super);
      } catch {
        setOk(false);
      }
    })();
  }, []);
  if (ok === null) return null;
  return ok ? children : <Navigate to="/SiteAdmin" replace />;
}


export default function App() {
  const location = useLocation();

  useEffect(() => {
    // Send SPA page_view on route changes
    gaPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <>
      <StartupSplash />
      <Routes>
      <Route path="/r/:key" element={<RedirectTrack />} />
      <Route
        path="/"
        element={
          (() => {
            const host = typeof window !== 'undefined' ? window.location.hostname : '';
            const isLocal = host === 'localhost' || host.includes('127.0.0.1');
            const isAppHost = host.startsWith('app.') || isLocal;

            return isAppHost ? <Navigate to="/Home" /> : <Landing />;
          })()
        }
      />
      {/* Public */}
      <Route path="/Home" element={<Home />} />
      {/* Marketing landing page (always accessible, even on localhost) */}
      <Route path="/landing" element={<Landing />} />
      <Route path="/Landing" element={<Navigate to="/landing" replace />} />
      <Route path="/how-to" element={<HowTo />} />
      <Route path="/howto" element={<Navigate to="/how-to" replace />} />
      <Route path="/SiteAdminLogin" element={<SiteAdminLogin />} />
      <Route path="/Register" element={<Register />} />
      <Route path="/ConfirmEmail" element={<ConfirmEmail />} />
      <Route path="/ForgotPassword" element={<ForgotPassword />} />
      <Route path="/ResetPassword" element={<ResetPassword />} />
      <Route
        path="/subscribe"
        element={
          <RequireAuth>
            <Subscribe />
          </RequireAuth>
        }
      />

      {/* Explicit SiteAdmin child paths (defensive): ensure /SiteAdmin/People works even if nesting breaks */}
      <Route
        path="/SiteAdmin/People"
        element={
          <RequireSiteAdminManage>
            <SiteAdminPeople />
          </RequireSiteAdminManage>
        }
      />
      <Route
        path="/SiteAdmin/Members"
        element={
          <RequireSiteAdminManage>
            <SiteAdminPeople />
          </RequireSiteAdminManage>
        }
      />
      <Route
        path="/SiteAdmin/siteadmins"
        element={
          <RequireSiteAdminManage>
            <SiteAdminPeople />
          </RequireSiteAdminManage>
        }
      />


      <Route
        path="/SiteAdmin/Support"
        element={
          <RequireSiteAdminSuper>
            <SiteAdminSupportSnapshot />
          </RequireSiteAdminSuper>
        }
      />
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
        {/* Reconciliation is available to validators + admins (any SiteAdmin-authorized user) */}
        <Route path="Reconciliation" element={<SiteAdminReconciliation />} />
        <Route path="AddActivity" element={<SiteAdminAddActivity />} />
        {/* Validators must be able to access Equipment & Locations */}
        <Route path="Equipment&Locations" element={<RequireSiteAdmin><SiteAdminEquipmentLocations /></RequireSiteAdmin>} />
        <Route path="Sites" element={<RequireSiteAdminSuper><SiteAdminSites /></RequireSiteAdminSuper>} />
        <Route path="People" element={<RequireSiteAdminManage><SiteAdminPeople /></RequireSiteAdminManage>} />
        <Route path="PowerBiTokens" element={<RequireSiteAdminManage><SiteAdminPowerBiTokens /></RequireSiteAdminManage>} />
        <Route path="Engagement" element={<RequireSiteAdminSuper><SiteAdminEngagement /></RequireSiteAdminSuper>} />
        <Route path="Support" element={<RequireSiteAdminSuper><SiteAdminSupportSnapshot /></RequireSiteAdminSuper>} />
        
        {/* allow lowercase for convenience */}
        <Route path="members" element={<Navigate to="/SiteAdmin/Members" replace />} />
        <Route path="ApproveFeedback" element={<RequireSiteAdminSuper><SiteAdminFeedbackApproval /></RequireSiteAdminSuper>} />
        <Route path="Seed" element={<RequireSiteAdminSuper><SiteAdminSeed /></RequireSiteAdminSuper>} />
        <Route path="Edit" element={<div className="p-6">Coming soon</div>} />
        <Route path="Export" element={<div className="p-6">Coming soon</div>} />

        {/* Backwards-compatible routes */}
        <Route path="CreateSite" element={<Navigate to="/SiteAdmin/Sites" replace />} />
        <Route
          path="CreateSiteAdministrators"
          element={<Navigate to="/SiteAdmin/People" replace />}
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
          <Route path="/Community" element={<Community />} />
        <Route path="/Equipment&Locations" element={<EquipmentLocations />} />
        {/* You Hub (tabs) */}
        <Route path="/You" element={<YouHub />}>
          <Route index element={<YouVsYou />} />
          <Route path="Crew" element={<YouVsNetwork />} />
        </Route>

        {/* Backwards-compatible routes */}
        <Route path="/YouVsYou" element={<Navigate to="/You" replace />} />
        <Route path="/YouVsNetwork" element={<Navigate to="/You/Crew" replace />} />
        <Route path="/Settings" element={<Settings />} />
        <Route path="/Subscription" element={<Subscription />} />
        <Route path="/subscription" element={<Navigate to="/Subscription" replace />} />
        <Route path="/NotificationPreferences" element={<NotificationPreferences />} />
        <Route path="/Feedback" element={<Feedback />} />
        <Route path="/Notifications" element={<Notifications />} />
          <Route path="/Terms" element={<Terms />} />
        <Route path="/Privacy" element={<Privacy />} />

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
    </>
  );
}