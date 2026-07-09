/**
 * App — router + auth gate. Every route except the sign-in screen requires an
 * authenticated session (SoW Phase 0: no unauthenticated route other than the
 * sign-in redirect). While the session loads we show a neutral splash; if
 * unauthenticated we render the SignIn screen regardless of the requested path.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './AppShell';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider } from './components/Toast';
import { Logo } from './components/Logo';

import { SignIn } from './screens/SignIn';
import { Dashboard } from './screens/Dashboard';
import { TenantConnections } from './screens/TenantConnections';
import { UserDiscovery } from './screens/UserDiscovery';
import { MappingProvisioning } from './screens/MappingProvisioning';
import { MigrationMonitor } from './screens/MigrationMonitor';
import { MigrationReports } from './screens/MigrationReports';
import { AuditLog } from './screens/AuditLog';
import { Settings } from './screens/Settings';

function Splash() {
  return (
    <div className="signin">
      <div className="row gap-3" aria-busy="true">
        <Logo size={32} />
        <span className="muted">Loading console…</span>
      </div>
    </div>
  );
}

/** Renders the authenticated shell, or the sign-in screen when unauthenticated. */
function Gate() {
  const { state } = useSession();

  if (state.status === 'loading') return <Splash />;
  if (state.status === 'unauthenticated') return <SignIn />;

  // An authenticated engineer who is not in the MSP security group is rejected
  // server-side at callback; if a stale session slips through, show sign-in.
  if (!state.me.groupOk) return <SignIn forbidden />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="/tenants" element={<TenantConnections />} />
        <Route path="/discovery" element={<UserDiscovery />} />
        <Route path="/mapping" element={<MappingProvisioning />} />
        <Route path="/monitor" element={<MigrationMonitor />} />
        <Route path="/reports" element={<MigrationReports />} />
        <Route path="/audit" element={<AuditLog />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
