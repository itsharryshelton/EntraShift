/**
 * Screen 5 — Mapping & Provisioning (branding §8.5, SoW Phase 3).
 *
 * source→target mapping table that ALWAYS shows the resolved target UPN on the
 * destination primary domain (never assumes a shared domain — cutover model),
 * auto-create toggles, and the one-time temp-password CSV download modal (§7.4)
 * which requires an acknowledge checkbox (the file contains credentials) before
 * the download button enables.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GitBranch,
  UserCog,
  KeyRound,
  Download,
  ShieldAlert,
  ArrowRight,
  Rocket,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  DataGrid,
  Button,
  Input,
  Badge,
  Banner,
  Modal,
  EmptyState,
  WorkloadPill,
  useToast,
  type Column,
} from '../components';
import { useAsync } from '../lib/useAsync';
import {
  migrationUsers as usersApi,
  provisioning,
  jobs as jobsApi,
  ApiError,
} from '../lib/api';
import type { MigrationUser, MappingStatus } from '@shared/contracts';

const MAP_BADGE: Record<MappingStatus, { label: string; variant: 'neutral' | 'success' | 'warning' | 'error' | 'info' }> = {
  unmapped: { label: 'Unmapped', variant: 'warning' },
  mapped: { label: 'Mapped', variant: 'success' },
  auto_create: { label: 'Auto-create', variant: 'info' },
  provisioned: { label: 'Provisioned', variant: 'success' },
  invalid: { label: 'Invalid target', variant: 'error' },
};

export function MappingProvisioning() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync<MigrationUser[]>(
    (s) => usersApi.list(s),
    [],
  );

  const [editing, setEditing] = useState<MigrationUser | null>(null);
  const [provisioning_, setProvisioning] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [credentialsPending, setCredentialsPending] = useState(false);
  const [starting, setStarting] = useState(false);

  const rows = data ?? [];

  const autoCreateCount = rows.filter((r) => r.autoCreateTarget).length;
  const readyToRun = rows.filter(
    (r) =>
      (r.mappingStatus === 'mapped' || r.mappingStatus === 'provisioned') &&
      (r.migrateExchange || r.migrateOneDrive),
  );

  const setAutoCreate = async (u: MigrationUser, next: boolean) => {
    try {
      await usersApi.updateMapping(u.id, {
        targetEmail: u.targetEmail,
        targetUpn: u.targetUpn,
        mappingStatus: next ? 'auto_create' : u.targetUpn ? 'mapped' : 'unmapped',
      });
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not update mapping.');
    }
  };

  const provisionAutoCreate = async () => {
    const ids = rows.filter((r) => r.autoCreateTarget && r.mappingStatus !== 'provisioned').map((r) => r.id);
    if (ids.length === 0) {
      toast.info('No users are marked for auto-create.');
      return;
    }
    setProvisioning(true);
    try {
      const res = await provisioning.provision(ids);
      if (res.failed.length) {
        toast.error(`${res.failed.length} user(s) failed to provision.`, 'Provisioning partial');
      } else {
        toast.success(`${res.provisioned.length} user(s) provisioned in the destination tenant.`);
      }
      if (res.credentialsPending) setCredentialsPending(true);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Provisioning failed.');
    } finally {
      setProvisioning(false);
    }
  };

  const startMigration = async () => {
    if (readyToRun.length === 0) return;
    setStarting(true);
    try {
      const created = await jobsApi.create(readyToRun.map((r) => r.id));
      toast.success(`${created.length} job(s) queued. Track them in the Migration Monitor.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not queue jobs.');
    } finally {
      setStarting(false);
    }
  };

  const columns: Column<MigrationUser>[] = [
    {
      key: 'source',
      header: 'Source user',
      cell: (u) => <span className="mono text-xs">{u.sourceEmail}</span>,
      mono: true,
    },
    {
      key: 'arrow',
      header: '',
      width: '32px',
      cell: () => <ArrowRight size={16} strokeWidth={1.75} color="var(--brand-shift-cyan)" />,
    },
    {
      key: 'target',
      header: 'Target UPN (destination primary domain)',
      cell: (u) =>
        u.targetUpn ? (
          <span className="mono text-xs">{u.targetUpn}</span>
        ) : (
          <span className="muted text-xs">— not resolved —</span>
        ),
    },
    {
      key: 'workloads',
      header: 'Workloads',
      cell: (u) => (
        <div className="row gap-2">
          {u.migrateExchange && <WorkloadPill workload="exchange" active />}
          {u.migrateOneDrive && <WorkloadPill workload="onedrive" active />}
        </div>
      ),
    },
    {
      key: 'auto',
      header: 'Auto-create',
      cell: (u) => (
        <label className="checkbox-row">
          <input
            type="checkbox"
            role="switch"
            aria-checked={u.autoCreateTarget}
            checked={u.autoCreateTarget}
            disabled={u.mappingStatus === 'provisioned'}
            onChange={(e) => void setAutoCreate(u, e.target.checked)}
          />
          <span className="text-xs muted">
            {u.mappingStatus === 'provisioned' ? 'provisioned' : 'create in dest'}
          </span>
        </label>
      ),
    },
    {
      key: 'status',
      header: 'Mapping',
      cell: (u) => {
        const m = MAP_BADGE[u.mappingStatus];
        return <Badge variant={m.variant}>{m.label}</Badge>;
      },
    },
    {
      key: 'actions',
      header: '',
      actions: true,
      cell: (u) => (
        <Button variant="ghost" size="sm" leftIcon={UserCog} onClick={() => setEditing(u)}>
          Map
        </Button>
      ),
    },
  ];

  return (
    <div className="section-gap">
      <PageHeader
        title="Mapping & Provisioning"
        description="Map each source user to a destination identity. Migrated users are matched against the destination tenant's existing primary domain — source-domain cutover is performed manually by an engineer afterwards and is out of scope for the tool."
        actions={
          <>
            <Button
              variant="secondary"
              leftIcon={UserCog}
              disabled={autoCreateCount === 0}
              loading={provisioning_}
              loadingLabel="Provisioning…"
              onClick={() => void provisionAutoCreate()}
            >
              Provision {autoCreateCount || ''} auto-create
            </Button>
            <Button
              variant="primary"
              leftIcon={Rocket}
              disabled={readyToRun.length === 0}
              loading={starting}
              loadingLabel="Queueing…"
              onClick={() => void startMigration()}
            >
              Start migration ({readyToRun.length})
            </Button>
          </>
        }
      />

      {credentialsPending && (
        <Banner
          tone="warning"
          title="Temporary credentials pending one-time download"
          action={
            <Button variant="secondary" size="sm" leftIcon={Download} onClick={() => setPwModalOpen(true)}>
              Download CSV
            </Button>
          }
        >
          Auto-created accounts were assigned random temporary passwords (force
          change at next sign-in). They are held encrypted and purged from D1 after
          a single CSV download.
        </Banner>
      )}

      {error && (
        <Banner tone="error" title="Could not load the migration queue">
          The control plane is unreachable. The queue will appear once it responds.
        </Banner>
      )}

      <Card flush>
        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(u) => u.id}
          loading={loading}
          caption="Source-to-target user mapping"
          emptyState={
            <EmptyState
              icon={GitBranch}
              message="No users in the migration queue yet. Discover or import users first."
              action={
                <Link to="/discovery">
                  <Button variant="primary" leftIcon={ArrowRight}>
                    Go to User Discovery
                  </Button>
                </Link>
              }
            />
          }
        />
      </Card>

      {editing && (
        <MapModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      <PasswordDownloadModal
        open={pwModalOpen}
        onClose={() => setPwModalOpen(false)}
        onDownloaded={() => {
          setPwModalOpen(false);
          setCredentialsPending(false);
        }}
      />
    </div>
  );
}

/* ---- Map a single user to a destination identity ---- */
function MapModal({
  user,
  onClose,
  onSaved,
}: {
  user: MigrationUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [targetEmail, setTargetEmail] = useState(user.targetEmail ?? '');
  const [saving, setSaving] = useState(false);

  // Preview: show the resolved UPN the Worker will validate against the
  // destination primary domain. This is illustrative until the PATCH returns
  // the authoritative resolution.
  const previewUpn = useMemo(() => targetEmail.trim() || user.targetUpn || '', [targetEmail, user.targetUpn]);

  const save = async (autoCreate: boolean) => {
    setSaving(true);
    try {
      await usersApi.updateMapping(user.id, {
        targetEmail: autoCreate ? null : targetEmail.trim() || null,
        targetUpn: autoCreate ? null : targetEmail.trim() || null,
        mappingStatus: autoCreate ? 'auto_create' : targetEmail.trim() ? 'mapped' : 'unmapped',
      });
      toast.success('Mapping updated.');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save mapping.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Map user to destination"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void save(true)} loading={saving} leftIcon={UserCog}>
            Auto-create instead
          </Button>
          <Button variant="primary" onClick={() => void save(false)} loading={saving} loadingLabel="Saving…">
            Save mapping
          </Button>
        </>
      }
    >
      <dl className="kv" style={{ marginBottom: 'var(--space-4)' }}>
        <dt>Source user</dt>
        <dd className="mono text-xs">{user.sourceEmail}</dd>
      </dl>
      <Input
        label="Target email / UPN (destination tenant)"
        secret={false}
        className="input--mono"
        value={targetEmail}
        onChange={(e) => setTargetEmail(e.target.value)}
        placeholder="user@destination-primary-domain.com"
        hint="Must resolve on the destination tenant's existing primary domain. The tool never assumes source and target share a domain."
      />
      {previewUpn && (
        <Banner tone="info" title="Resolved target UPN">
          <span className="mono text-xs">{previewUpn}</span>
        </Banner>
      )}
    </Modal>
  );
}

/* ---- One-time temp-password CSV download (§7.4) ---- */
function PasswordDownloadModal({
  open,
  onClose,
  onDownloaded,
}: {
  open: boolean;
  onClose: () => void;
  onDownloaded: () => void;
}) {
  const toast = useToast();
  const [ack, setAck] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const doDownload = async () => {
    if (!ack) return;
    setDownloading(true);
    try {
      const csv = await provisioning.downloadPasswords(true);
      // Trigger a client-side download of the returned CSV text.
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `entrashift-temp-credentials-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Credentials downloaded. Plaintext has been purged from D1.', 'One-time download complete');
      setAck(false);
      onDownloaded();
    } catch (e) {
      toast.error(
        e instanceof ApiError ? e.message : 'Download failed. Credentials remain pending.',
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        setAck(false);
        onClose();
      }}
      title="Download temporary credentials"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={downloading}>
            Cancel
          </Button>
          <Button
            variant="danger"
            leftIcon={Download}
            disabled={!ack}
            loading={downloading}
            loadingLabel="Preparing…"
            onClick={() => void doDownload()}
          >
            Download CSV
          </Button>
        </>
      }
    >
      <div className="modal__consequence">
        <span style={{ flex: 'none' }}>
          <ShieldAlert size={20} strokeWidth={1.75} />
        </span>
        <div>
          <strong>This file contains plaintext credentials.</strong> It is a{' '}
          <strong>one-time download</strong> — after it completes, the encrypted
          passwords are purged from D1 and cannot be retrieved again. Every account
          is set to force a password change at next sign-in. Handle and delete the
          file per your credential-handling policy. The download is audit-logged.
        </div>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        <span>
          I understand this file contains credentials, it is a one-time download,
          and I will store and delete it securely.
        </span>
      </label>
      <p className="row gap-2 muted text-xs" style={{ marginTop: 'var(--space-4)' }}>
        <KeyRound size={14} strokeWidth={1.75} />
        Passwords never appear in the browser UI — only in the downloaded file.
      </p>
    </Modal>
  );
}
