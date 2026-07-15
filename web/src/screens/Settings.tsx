/**
 * Screen 9 — Settings (branding §8.9, SoW Phase 0/4/5).
 *
 * Engine/app configuration: concurrency caps, poll floor, retry budget, and
 * audit retention. Also surfaces secret-rotation (delegated to Tenant
 * Connections — secrets are never entered or shown here) and the VM ↔ control
 * -plane service-token auth model.
 *
 * SECURITY: this screen never displays or accepts secrets. The master
 * encryption key and OIDC/tenant secrets live only in the Worker (Worker Secret
 * + envelope-encrypted D1). Rotation happens via re-entry on the Tenant screen.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Save,
  KeyRound,
  ServerCog,
  ShieldCheck,
  Clock,
  Gauge,
  ArrowRight,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  Button,
  Input,
  Banner,
  Badge,
  Icon,
  useToast,
} from '../components';
import { useAsync } from '../lib/useAsync';
import { config as configApi, ApiError } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { EngineConfig } from '@shared/contracts';

/**
 * The api-spec config endpoint covers "concurrency, retention, poll floor".
 * EngineConfig (contracts.ts) enumerates the engine fields; retention lives in
 * the same config store, so we model it as an optional extension here.
 */
type AppConfig = EngineConfig & { auditRetentionDays?: number };

export function Settings() {
  const toast = useToast();
  const { data, loading, error } = useAsync<EngineConfig>((s) => configApi.get(s), []);
  const [form, setForm] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm({ auditRetentionDays: 90, ...(data as AppConfig) });
  }, [data]);

  const setNum = (key: keyof AppConfig, value: string) =>
    setForm((f) => (f ? { ...f, [key]: Number(value) } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      // config.update takes Partial<EngineConfig>; the retention key is carried
      // through the same endpoint (see AppConfig note above).
      await configApi.update(form as Partial<EngineConfig>);
      toast.success('Engine configuration saved.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section-gap">
      <PageHeader
        title="Settings"
        description="Engine runtime configuration, secret rotation, and the VM service-token status. Conservative defaults are tuned to stay inside the Cloudflare Free Tier."
        actions={
          <Button
            variant="primary"
            leftIcon={Save}
            loading={saving}
            loadingLabel="Saving…"
            disabled={!form}
            onClick={() => void save()}
          >
            Save changes
          </Button>
        }
      />

      {error && (
        <Banner tone="error" title="Could not load configuration">
          The control plane is unreachable. Defaults are shown; saving is disabled
          until it responds.
        </Banner>
      )}

      {form?.paused && (
        <Banner tone="warning" title="Budget governor active">
          The free-tier budget governor has paused non-essential work. The engine is
          idling until daily counters reset (UTC) or usage falls below the soft
          threshold.
        </Banner>
      )}

      {/* Engine throughput / throttling */}
      <Card
        title={
          <span className="row gap-2">
            <Icon icon={Gauge} size={18} /> Engine throughput & throttling
          </span>
        }
        subtitle="Concurrency caps and retry budget. Lower values are gentler on Graph throttling."
      >
        {loading || !form ? (
          <SkeletonForm />
        ) : (
          <div className="grid-cards grid-2">
            <Input
              label="Per-mailbox concurrency"
              type="number"
              min={1}
              value={form.perMailboxConcurrency}
              onChange={(e) => setNum('perMailboxConcurrency', e.target.value)}
              hint="Parallel operations against a single mailbox."
            />
            <Input
              label="Per-tenant concurrency"
              type="number"
              min={1}
              value={form.perTenantConcurrency}
              onChange={(e) => setNum('perTenantConcurrency', e.target.value)}
              hint="Parallel mailboxes/drives per tenant."
            />
            <Input
              label="Exchange export batch size"
              type="number"
              min={1}
              max={20}
              value={form.exchangeExportBatchSize}
              onChange={(e) => setNum('exchangeExportBatchSize', e.target.value)}
              hint="Graph hard limit is 20 items per exportItems call."
            />
            <Input
              label="Item retry budget"
              type="number"
              min={0}
              value={form.itemMaxRetries}
              onChange={(e) => setNum('itemMaxRetries', e.target.value)}
              hint="Retries before an item is skip-and-logged."
            />
            <Input
              label="OneDrive upload-session threshold (bytes)"
              type="number"
              min={0}
              className="input--mono"
              value={form.onedriveUploadSessionThresholdBytes}
              onChange={(e) => setNum('onedriveUploadSessionThresholdBytes', e.target.value)}
              hint={`Files above this use resumable sessions (${formatBytes(form.onedriveUploadSessionThresholdBytes)}). Graph: > 4 MB.`}
            />
          </div>
        )}
      </Card>

      {/* Poll floor + retention (free-tier discipline) */}
      <Card
        title={
          <span className="row gap-2">
            <Icon icon={Clock} size={18} /> Free-tier discipline
          </span>
        }
        subtitle="Server-enforced poll floor and audit retention keep Cloudflare usage inside Free Tier."
      >
        {loading || !form ? (
          <SkeletonForm />
        ) : (
          <div className="grid-cards grid-2">
            <Input
              label="Minimum poll interval (seconds)"
              type="number"
              min={30}
              value={form.minPollIntervalSec}
              onChange={(e) => setNum('minPollIntervalSec', e.target.value)}
              hint="Floor is 30s — the engine and UI must not poll faster (D1 write budget)."
            />
            <Input
              label="Audit retention (days)"
              type="number"
              min={1}
              max={90}
              value={form.auditRetentionDays ?? 90}
              onChange={(e) => setNum('auditRetentionDays', e.target.value)}
              hint="Rolling window; export to CSV before pruning. Max 90 (D1 storage)."
            />
          </div>
        )}
      </Card>

      {/* Secret rotation — delegated, never here */}
      <Card
        title={
          <span className="row gap-2">
            <Icon icon={KeyRound} size={18} /> Secret rotation
          </span>
        }
        actions={
          <Link to="/tenants">
            <Button variant="secondary" size="sm" rightIcon={ArrowRight}>
              Tenant Connections
            </Button>
          </Link>
        }
      >
        <Banner tone="info" title="Secrets are never entered or shown on this screen">
          Tenant client secrets are rotated by re-entry on the Tenant Connections
          screen and are AES-256-GCM envelope-encrypted in the Worker. The master
          encryption key is a Cloudflare Worker Secret set out-of-band via{' '}
          <span className="mono text-xs">wrangler secret put</span> — it is never
          in source, the dashboard, or the browser.
        </Banner>
      </Card>

      {/* VM / service-token status */}
      <Card
        title={
          <span className="row gap-2">
            <Icon icon={ServerCog} size={18} /> Migration engine (Azure VM)
          </span>
        }
        subtitle="Authenticated to the control plane via a Cloudflare Access service token."
      >
        <div className="stack gap-4">
          <dl className="kv">
            <dt>Auth mechanism</dt>
            <dd className="row gap-2">
              <Badge variant="success" icon={ShieldCheck}>
                Cf-Access service token
              </Badge>
            </dd>
            <dt>Queue consumption</dt>
            <dd className="text-sm muted">
              HTTP pull with a queue-consume-scoped Cloudflare API token (not a Worker
              consumer). Job dispatch only — all progress flows through D1.
            </dd>
            <dt>Credential store</dt>
            <dd className="text-sm muted">
              Azure Key Vault, accessed by the VM via managed identity. Each
              credential is independently revocable.
            </dd>
            <dt>Live health</dt>
            <dd>
              <Badge variant="neutral">Reported via job heartbeat</Badge>
            </dd>
          </dl>
        </div>
      </Card>
    </div>
  );
}

function SkeletonForm() {
  return (
    <div className="grid-cards grid-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="stack gap-2">
          <div className="skeleton" style={{ height: 14, width: 140 }} />
          <div className="skeleton" style={{ height: 36 }} />
        </div>
      ))}
    </div>
  );
}
