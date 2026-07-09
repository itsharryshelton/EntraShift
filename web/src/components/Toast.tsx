/**
 * Toast (§7.3). Bottom-right. success/info auto-dismiss after 5s; errors NEVER
 * auto-dismiss (must be dismissed manually). Exposed via a context provider +
 * useToast() hook so any screen can push a toast.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { Icon } from './Icon';

type ToastTone = 'success' | 'info' | 'error';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title?: string;
  message: string;
}

interface ToastApi {
  success: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  /** Errors never auto-dismiss (§7.3). */
  error: (message: string, title?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON = { success: CheckCircle2, info: Info, error: XCircle } as const;
const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, title?: string) => {
      const id = nextId.current++;
      setItems((prev) => [...prev, { id, tone, message, title }]);
      // Errors persist until dismissed; success/info auto-dismiss after 5s.
      if (tone !== 'error') {
        setTimeout(() => remove(id), AUTO_DISMISS_MS);
      }
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, t) => push('success', m, t),
      info: (m, t) => push('info', m, t),
      error: (m, t) => push('error', m, t),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="toast-region"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} role="status">
            <span className="toast__icon">
              <Icon icon={TONE_ICON[t.tone]} size={18} />
            </span>
            <div className="toast__body">
              {t.title && <div className="toast__title">{t.title}</div>}
              <div className="toast__msg">{t.message}</div>
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => remove(t.id)}
              aria-label="Dismiss notification"
            >
              <Icon icon={X} size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
