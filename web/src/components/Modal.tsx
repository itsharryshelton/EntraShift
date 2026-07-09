/**
 * Modal (§6.3, §7.3). Esc closes; focus is trapped and restored; overlay click
 * closes non-destructive modals. Includes ConfirmModal for destructive actions
 * with explicit consequence text and an optional typed-confirmation (used for
 * tenant disconnect — the engineer must type the tenant identifier).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Icon } from './Icon';
import { Button } from './Button';
import { Input } from './Input';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Prevent overlay-click / Esc close (e.g. mid-flight critical action). */
  dismissable?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  dismissable = true,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab') trapFocus(e);
    };

    const trapFocus = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    // Move focus into the dialog.
    const timer = setTimeout(() => {
      const focusable = ref.current?.querySelector<HTMLElement>(
        'input, button, [tabindex]',
      );
      focusable?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
      >
        <header className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          {dismissable && (
            <button
              type="button"
              className="banner__close"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <Icon icon={X} size={18} />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: ReactNode;
  /** Explicit consequence text (§7.3). */
  consequence: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /**
   * When set, the confirm button stays disabled until the engineer types this
   * exact string (typed-confirmation, required for tenant disconnect — §7.3).
   */
  typedConfirmation?: string;
  loading?: boolean;
  children?: ReactNode;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel = 'Confirm',
  destructive = true,
  typedConfirmation,
  loading = false,
  children,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const needsTyped = Boolean(typedConfirmation);
  const canConfirm = !needsTyped || typed.trim() === typedConfirmation;

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    void onConfirm();
  }, [canConfirm, onConfirm]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={!canConfirm}
            loading={loading}
            loadingLabel="Working…"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="modal__consequence">
        <span style={{ flex: 'none' }}>
          <Icon icon={AlertTriangle} size={20} />
        </span>
        <div>{consequence}</div>
      </div>
      {children}
      {needsTyped && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Input
            label={
              <>
                Type <code className="mono">{typedConfirmation}</code> to confirm
              </>
            }
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            placeholder={typedConfirmation}
          />
        </div>
      )}
    </Modal>
  );
}
