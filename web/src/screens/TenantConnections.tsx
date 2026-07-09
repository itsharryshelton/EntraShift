/**
 * Screen 3 — Tenant Connections (branding §8.3, SoW Phase 1).
 *
 * Source/destination setup with the dual-state StatusCard (§5.1), a connection
 * test that renders a per-scope pass/fail consent checklist, and secret rotation.
 *
 * SECURITY (org policy + SoW Phase 0): the client secret is a write-only field.
 * It is POSTed once to the Worker (which AES-256-GCM envelope-encrypts it in D1)
 * and is NEVER read back — there is no reveal, only masked metadata + expiry.
 * Nothing sensitive is retained in the browser.
 */
import { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  PlugZap,
  RefreshCw,
  Trash2,
  KeyRound,
  ShieldQuestion,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  StatusCard,
  Button,
  Input,
  Modal,
  ConfirmModal,
  Banner,
  Icon,
  useToast,
} from '../components';
import { useAsync } from '../lib/useAsync';
import {
  tenants as tenantsApi,
  ApiError,
  type TenantSummary,
  type TenantTestResult,
} from '../lib/api';
import { formatDateTimeUtc } from '../lib/format';
import type { TenantRole } from '@shared/contracts';

const ROLE_TITLE: Record<TenantRole, string> = {
  source: 'Source Tenant',
  destination: 'Destination Tenant',
};

export function TenantConnections() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync<TenantSummary[]>(
    (s) => tenantsApi.list(s),
    [],
  );

  const [connectRole, setConnectRole] = useState<TenantRole | null>(null);
  const [rotateTenant, setRotateTenant] = useState<TenantSummary | null>(null);
  const [disconnectTenant, setDisconnectTenant] = useState<TenantSummary | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TenantTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const byRole = (role: TenantRole) => data?.find((t) => t.role === role) ?? null;

  const runTest = async (t: TenantSummary) => {
    setTesting(t.id);
    try {
      const result = await tenantsApi.test(t.id);
      setTestResults((prev) => ({ ...prev, [t.id]: result }));
      if (result.tokenAcquired && result.missingConsents.length === 0) {
        toast.success(`${ROLE_TITLE[t.role]} connection verified.`, 'Connection test passed');
      } else {
        toast.error(
          result.missingConsents.length
            ? `${result.missingConsents.length} required consent(s) missing.`
            : 'Token acquisition failed. Check tenant/client IDs and secret.',
          'Connection test found issues',
        );
      }
      reload();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : 'Connection test could not run.',
        'Test failed',
      );
    } finally {
      setTesting(null);
    }
  };

  const doDisconnect = async () => {
    if (!disconnectTenant) return;
    setBusyId(disconnectTenant.id);
    try {
      await tenantsApi.disconnect(disconnectTenant.id);
      toast.success(`${ROLE_TITLE[disconnectTenant.role]} disconnected.`);
      setDisconnectTenant(null);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[disconnectTenant.id];
        return next;
      });
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Disconnect failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="section-gap">
      <PageHeader
        title="Tenant Connections"
        description="Link the source and destination Microsoft 365 tenants via multi-tenant App Registrations (application permissions + admin consent). Least-privilege scopes only — no global admin credentials."
      />

      {error && (
        <Banner tone="error" title="Could not load tenants">
          The control plane is unreachable. Connection metadata will appear once it
          responds.
        </Banner>
      )}

      <div className="grid-cards grid-2">
        {(['source', 'destination'] as TenantRole[]).map((role) => {
          const t = byRole(role);
          const status = t?.status ?? 'disconnected';
          return (
            <StatusCard
              key={role}
              role={role}
              status={loading && !t ? 'disconnected' : status}
              tenantId={t?.tenantId}
              clientId={t?.clientId}
              secretExpiry={t?.secretExpiry}
              lastTestedAt={t?.lastTestedAt}
              action={
                t ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={RefreshCw}
                      loading={testing === t.id}
                      loadingLabel="Testing…"
                      onClick={() => void runTest(t)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={KeyRound}
                      onClick={() => setRotateTenant(t)}
                    >
                      Rotate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={Trash2}
                      onClick={() => setDisconnectTenant(t)}
                    >
                      Disconnect
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={PlugZap}
                    onClick={() => setConnectRole(role)}
                  >
                    Connect {ROLE_TITLE[role]}
                  </Button>
                )
              }
            />
          );
        })}
      </div>

      {/* Consent checklists from the most recent test */}
      <div className="grid-cards grid-2">
        {(['source', 'destination'] as TenantRole[]).map((role) => {
          const t = byRole(role);
          const result = t ? testResults[t.id] : undefined;
          return (
            <Card
              key={role}
              title={`${ROLE_TITLE[role]} — permission consent`}
              subtitle={
                t?.lastTestedAt
                  ? `Last tested ${formatDateTimeUtc(t.lastTestedAt)}`
                  : 'Run a connection test to verify admin-consented scopes'
              }
            >
              {result ? (
                <ConsentChecklist result={result} />
              ) : (
                <div className="row gap-2 muted text-sm">
                  <Icon icon={ShieldQuestion} size={16} />
                  No test results yet. Use “Test” to acquire an app-only token and
                  probe required Graph scopes.
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {connectRole && (
        <ConnectModal
          role={connectRole}
          onClose={() => setConnectRole(null)}
          onConnected={() => {
            setConnectRole(null);
            reload();
          }}
        />
      )}

      {rotateTenant && (
        <RotateModal
          tenant={rotateTenant}
          onClose={() => setRotateTenant(null)}
          onRotated={() => {
            setRotateTenant(null);
            reload();
          }}
        />
      )}

      <ConfirmModal
        open={Boolean(disconnectTenant)}
        onClose={() => setDisconnectTenant(null)}
        onConfirm={doDisconnect}
        loading={busyId === disconnectTenant?.id}
        title="Disconnect tenant"
        confirmLabel="Disconnect tenant"
        typedConfirmation={disconnectTenant?.tenantId}
        consequence={
          <>
            Disconnecting the <strong>{disconnectTenant && ROLE_TITLE[disconnectTenant.role]}</strong>{' '}
            permanently removes its encrypted client secret and connection metadata
            from D1. Any queued or running jobs for this tenant will fail on their
            next token request. This cannot be undone.
          </>
        }
      />
    </div>
  );
}

function ConsentChecklist({ result }: { result: TenantTestResult }) {
  return (
    <div className="stack gap-3">
      {!result.tokenAcquired && (
        <Banner tone="error" title="Token acquisition failed">
          {result.message ??
            'The Worker could not acquire an app-only token. Verify the tenant ID, client ID, and client secret.'}
        </Banner>
      )}
      <ul className="scope-list">
        {result.scopes.map((s) => (
          <li key={s.scope}>
            <Icon
              icon={s.granted ? CheckCircle2 : XCircle}
              size={16}
              color={
                s.granted ? 'var(--color-success)' : 'var(--color-error)'
              }
            />
            <span className="scope-list__scope">{s.scope}</span>
            {s.purpose && <span className="scope-list__purpose">{s.purpose}</span>}
          </li>
        ))}
      </ul>
      {result.missingConsents.length > 0 && (
        <Banner tone="warning" title="Missing admin consent">
          The following scopes require admin consent in the tenant:{' '}
          <span className="mono text-xs">{result.missingConsents.join(', ')}</span>
        </Banner>
      )}
    </div>
  );
}

/* ---- Connect modal (create tenant) ---- */
function ConnectModal({
  role,
  onClose,
  onConnected,
}: {
  role: TenantRole;
  onClose: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const guid = /^[0-9a-fA-F-]{36}$/;

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!guid.test(tenantId.trim())) next.tenantId = 'Enter a valid tenant GUID.';
    if (!guid.test(clientId.trim())) next.clientId = 'Enter a valid client (application) GUID.';
    if (clientSecret.trim().length < 8) next.clientSecret = 'Enter the client secret value.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    try {
      await tenantsApi.create({
        role,
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        clientSecret,
      });
      // Clear the plaintext secret from state immediately after send.
      setClientSecret('');
      toast.success(`${ROLE_TITLE[role]} connected. Run a test to verify scopes.`);
      onConnected();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save tenant.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${ROLE_TITLE[role]}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            loadingLabel="Encrypting & saving…"
          >
            Save connection
          </Button>
        </>
      }
    >
      <Banner tone="info" title="How the secret is handled">
        The client secret is sent once over TLS and AES-256-GCM envelope-encrypted
        in the Worker before storage. Only ciphertext is written to D1. It is never
        returned to the browser and never logged. To change it later you must
        re-enter it — there is no reveal.
      </Banner>
      <div className="stack gap-4" style={{ marginTop: 'var(--space-4)' }}>
        <Input
          label="Directory (tenant) ID"
          required
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="input--mono"
          error={errors.tenantId}
        />
        <Input
          label="Application (client) ID"
          required
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="input--mono"
          error={errors.clientId}
        />
        <Input
          label="Client secret value"
          required
          secret
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Paste the secret value (write-only)"
          hint="Stored encrypted; masked as metadata after save."
          error={errors.clientSecret}
        />
      </div>
    </Modal>
  );
}

/* ---- Rotate secret modal ---- */
function RotateModal({
  tenant,
  onClose,
  onRotated,
}: {
  tenant: TenantSummary;
  onClose: () => void;
  onRotated: () => void;
}) {
  const toast = useToast();
  const [clientSecret, setClientSecret] = useState('');
  const [expiry, setExpiry] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (clientSecret.trim().length < 8) {
      setErr('Enter the new client secret value.');
      return;
    }
    setSubmitting(true);
    try {
      await tenantsApi.rotateSecret(tenant.id, {
        clientSecret,
        secretExpiry: expiry || undefined,
      });
      setClientSecret('');
      toast.success('Client secret rotated. Run a connection test to verify.');
      onRotated();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Rotation failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Rotate secret — ${ROLE_TITLE[tenant.role]}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={submitting}
            loadingLabel="Encrypting…"
          >
            Rotate secret
          </Button>
        </>
      }
    >
      <Banner tone="info">
        Rotation replaces the encrypted secret in D1. Re-entry is required — the
        current secret cannot be revealed.
      </Banner>
      <div className="stack gap-4" style={{ marginTop: 'var(--space-4)' }}>
        <Input
          label="New client secret value"
          required
          secret
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          error={err}
        />
        <Input
          label="Secret expiry (optional)"
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          hint="Shown as metadata so the console can warn before expiry."
        />
      </div>
    </Modal>
  );
}
