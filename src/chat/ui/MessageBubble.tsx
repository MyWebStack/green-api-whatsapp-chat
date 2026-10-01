import { Check, Clock3, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Message, RequestState } from '../domain/model';
import styles from './MessageBubble.module.scss';

const clock = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });

const requestView: Record<RequestState, { label: string; icon: LucideIcon; failed: boolean }> = {
  sending: { label: 'Отправляется', icon: Clock3, failed: false },
  accepted: { label: 'Принято API', icon: Check, failed: false },
  rejected: { label: 'Не отправлено', icon: TriangleAlert, failed: true },
  unknown: { label: 'Результат неизвестен', icon: TriangleAlert, failed: true },
};

export function MessageBubble({
  message,
  senderName,
  onRetry,
  onRestore,
  onOpenActions,
  ready,
}: {
  message: Message;
  senderName: string;
  onRetry(message: Message, opener: HTMLElement): void;
  onRestore(message: Message, opener: HTMLElement): void;
  onOpenActions(message: Message, x: number, y: number, opener: HTMLElement): void;
  ready: boolean;
}) {
  const outgoing = message.direction === 'outgoing';
  const { label, icon: StatusIcon, failed } = requestView[message.request];
  const canOpenActions = outgoing && !message.deleted && message.request !== 'sending';

  return (
    <article
      data-message-id={message.localId}
      className={`${styles.messageRow} ${outgoing ? styles.outgoing : ''}`}
      aria-label={`Сообщение от ${outgoing ? 'вас' : senderName}`}
    >
      <div
        className={`${styles.bubble} ${failed && !message.deleted ? styles.failedBubble : ''}`}
        onContextMenu={(event) => {
          if (!canOpenActions) return;
          event.preventDefault();
          onOpenActions(message, event.clientX, event.clientY, event.currentTarget);
        }}
      >
        <p className={message.deleted ? styles.deletedText : styles.messageText}>
          {message.deleted ? 'Сообщение удалено' : message.text}
        </p>
        <div className={styles.messageMeta}>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {clock.format(message.createdAt)}
          </time>
          {outgoing && !message.deleted && (
            <span className={styles.requestStatus} role="img" aria-label={label} title={label}>
              <StatusIcon size={16} aria-hidden="true" />
            </span>
          )}
        </div>
        {failed && !message.deleted && (
          <div className={styles.messageFailure}>
            <span>{label}</span>
            {message.error && <p>{message.error}</p>}
            <div>
              <button
                type="button"
                onClick={(event) => onRetry(message, event.currentTarget)}
                disabled={!ready}
              >
                Повторить
              </button>
              <button type="button" onClick={(event) => onRestore(message, event.currentTarget)}>
                В поле ввода
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
