/**
 * Screen 1 — Sign-in (branding §8.1, SoW Phase 0).
 *
 * Entra ID SSO redirect page ONLY. Centered logo, a single "Sign in with
 * Microsoft" button, and a security posture one-liner. There are NO local
 * credential fields here, ever — authentication is delegated entirely to Entra
 * ID (OIDC Auth-Code + PKCE, handled by the Worker). This is a hard rule from
 * the org security policy and the SoW.
 */
import { LogIn, ShieldCheck } from 'lucide-react';
import { Icon } from '../components/Icon';
import { Button } from '../components/Button';
import { Banner } from '../components/Banner';
import { Logo } from '../components/Logo';
import { signInRedirect } from '../lib/api';
import { useAppInfo } from '../lib/appInfo';

export function SignIn({ forbidden = false }: { forbidden?: boolean }) {
  const { projectName } = useAppInfo();
  return (
    <div className="signin">
      <div className="signin__card">
        <Logo size={40} />

        {/* Per-customer project — one Worker per customer, obvious before sign-in. */}
        <div className="signin__project" title="This EntraShift instance serves one customer">
          <span className="signin__project-kicker">Project</span>
          <span className="signin__project-name">{projectName}</span>
        </div>

        <div className="stack gap-2" style={{ alignItems: 'center' }}>
          <h1 style={{ fontSize: 'var(--fs-lg)' }}>Migration Console</h1>
          <p className="muted text-sm" style={{ maxWidth: '32ch' }}>
            Secure Microsoft 365 tenant-to-tenant migration. Access is restricted
            to authorised MSP engineers.
          </p>
        </div>

        {forbidden && (
          <Banner tone="error" title="Access denied">
            Your account signed in successfully but is not a member of the
            authorised MSP security group. Contact an administrator.
          </Banner>
        )}

        {/* Single SSO action. No username/password fields — by design. */}
        <Button
          variant="primary"
          size="lg"
          block
          leftIcon={LogIn}
          onClick={() => signInRedirect()}
        >
          Sign in with Microsoft
        </Button>

        <div className="signin__security">
          <Icon icon={ShieldCheck} size={16} />
          <span>
            Single sign-on via Microsoft Entra ID (OAuth 2.0 Authorization Code +
            PKCE). No credentials are entered or stored here.
          </span>
        </div>
      </div>
    </div>
  );
}
