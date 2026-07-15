/**
 * AppShell (branding §6.2). 240px Console Slate sidebar with Lucide nav that
 * collapses to a 64px icon rail at 1024–1279px and becomes an overlay drawer
 * below 1024px. Top bar carries the drawer toggle, theme switch, and the signed
 * -in engineer chip. All nav is keyboard reachable; the active route is marked
 * with aria-current="page".
 */
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  PlugZap,
  Users,
  GitBranch,
  Activity,
  FileBarChart2,
  ScrollText,
  Settings as SettingsIcon,
  Menu,
  Moon,
  Sun,
  LogOut,
} from 'lucide-react';
import { Icon } from './components/Icon';
import { Logo } from './components/Logo';
import { useTheme } from './lib/theme';
import { useSession } from './lib/session';
import { useAppInfo } from './lib/appInfo';
import { signOut } from './lib/api';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/tenants', label: 'Tenant Connections', icon: PlugZap },
  { to: '/discovery', label: 'User Discovery', icon: Users },
  { to: '/mapping', label: 'Mapping & Provisioning', icon: GitBranch },
  { to: '/monitor', label: 'Migration Monitor', icon: Activity },
  { to: '/reports', label: 'Reports', icon: FileBarChart2 },
  { to: '/audit', label: 'Audit Log', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppShell() {
  const { theme, toggle } = useTheme();
  const { state } = useSession();
  const { projectName } = useAppInfo();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const me = state.status === 'authenticated' ? state.me : null;
  const initials = me?.displayName
    ? me.displayName
        .split(/\s+/)
        .map((s) => s[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '··';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
      )}

      <aside
        className={`sidebar ${drawerOpen ? 'sidebar--open' : ''}`}
        aria-label="Primary navigation"
      >
        <div className="sidebar__brand">
          <Logo size={26} onDark />
        </div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : undefined}
              className="nav-item"
              title={item.label}
            >
              <Icon icon={item.icon} size={20} />
              <span className="nav-item__label">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div>EntraShift</div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button
            type="button"
            className="topbar__menu-btn"
            onClick={() => setDrawerOpen((o) => !o)}
            aria-label="Toggle navigation"
            aria-expanded={drawerOpen}
          >
            <Icon icon={Menu} size={20} />
          </button>

          {/* Per-customer project label — one Worker per customer, so make the target obvious. */}
          <div
            className="topbar__project"
            title={`Project: ${projectName} — this EntraShift instance serves one customer`}
          >
            <span className="topbar__project-kicker">Project</span>
            <span className="topbar__project-name">{projectName}</span>
          </div>

          <div className="topbar__spacer" />
          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            <Icon icon={theme === 'dark' ? Sun : Moon} size={18} />
          </button>
          {me && (
            <div className="user-chip" title={me.upn}>
              <span className="user-chip__avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="user-chip__name">{me.displayName || me.upn}</span>
              <button
                type="button"
                className="icon-btn"
                style={{ width: 28, height: 28, border: 'none', background: 'transparent' }}
                aria-label="Sign out"
                title="Sign out"
                onClick={() => {
                  void signOut().finally(() => window.location.assign('/'));
                }}
              >
                <Icon icon={LogOut} size={16} />
              </button>
            </div>
          )}
        </header>

        <main className="content" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
