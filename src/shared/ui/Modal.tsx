import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import styles from './Modal.module.scss';

export function Modal({
  title,
  onClose,
  children,
  returnFocusTo,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  returnFocusTo?: HTMLElement | RefObject<HTMLElement | null> | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener =
      returnFocusTo ||
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog?.showModal();
    return () => {
      dialog?.close();
      requestAnimationFrame(() => {
        const target = opener && 'current' in opener ? opener.current : opener;
        const active = document.activeElement;
        if (
          target?.isConnected &&
          target.getClientRects().length > 0 &&
          (!active ||
            active === document.body ||
            !active.isConnected ||
            (active instanceof HTMLElement && active.getClientRects().length === 0))
        ) {
          target.focus();
        }
      });
    };
  }, [returnFocusTo]);
  return (
    <dialog
      ref={ref}
      className={styles.modal}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className={styles.heading}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" className={styles.closeButton} aria-label="Закрыть" onClick={onClose}>
          <X />
        </button>
      </div>
      {children}
    </dialog>
  );
}
