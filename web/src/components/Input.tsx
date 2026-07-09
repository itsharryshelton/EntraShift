/**
 * Input (§7.3, §7.4). Inline error = crimson border + icon + text (never color
 * alone). Secret fields render in JetBrains Mono and mask input; there is no
 * post-save "reveal" anywhere in the product (§7.4) — masking here is only for
 * shoulder-surfing while typing a value that will be sent once and encrypted
 * server-side.
 */
import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Icon } from './Icon';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Monospace + secret handling: type=password, optional show-while-typing. */
  secret?: boolean;
  /** Allow toggling visibility WHILE ENTERING only (never after save). */
  allowPeek?: boolean;
}

export function Input({
  label,
  hint,
  error,
  required,
  secret,
  allowPeek = true,
  id,
  className,
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const [peek, setPeek] = useState(false);

  const showToggle = secret && allowPeek;
  const inputType = secret && !peek ? 'password' : (rest.type ?? 'text');

  const classes = [
    'input',
    secret && 'input--mono',
    error && 'input--error',
    showToggle && 'input--has-icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="field">
      {label && (
        <label className="field__label" htmlFor={inputId}>
          {label}
          {required && (
            <span className="field__req" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <div className="input-wrap">
        <input
          {...rest}
          id={inputId}
          type={inputType}
          className={classes}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete={secret ? 'off' : rest.autoComplete}
          spellCheck={secret ? false : rest.spellCheck}
        />
        {showToggle && (
          <button
            type="button"
            className="input__icon-btn"
            onClick={() => setPeek((p) => !p)}
            aria-label={peek ? 'Hide value' : 'Show value while typing'}
            tabIndex={0}
          >
            <Icon icon={peek ? EyeOff : Eye} size={16} />
          </button>
        )}
      </div>
      {hint && !error && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field__error" id={errorId} role="alert">
          <Icon icon={AlertCircle} size={14} />
          {error}
        </span>
      )}
    </div>
  );
}
