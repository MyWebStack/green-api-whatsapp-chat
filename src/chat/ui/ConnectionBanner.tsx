import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useChatState, useRuntime } from '../../app/context';
import { Modal } from '../../shared/ui/Modal';
import ui from '../../shared/styles/ui.module.scss';
import styles from './ConnectionBanner.module.scss';

export function ConnectionBanner() {
  const runtime = useRuntime();
  const notice = useChatState((s) => s.notice);
  const phase = useChatState((s) => s.phase);
  const online = useChatState((s) => s.online);
  const storageWarning = useChatState((s) => s.storageWarning);
  const blockedNotificationId = useChatState((s) => s.blockedNotificationId);
  const [skipOpener, setSkipOpener] = useState<HTMLElement | null>(null);
  const [skipping, setSkipping] = useState(false);
  if (!notice && phase === 'active' && online && !storageWarning) return null;

  let message = notice || 'Восстанавливаем соединение…';
  if (!online) {
    message = 'Нет соединения. Вы можете читать переписку и писать черновики.';
  } else if (!notice && storageWarning) {
    message =
      'Браузер не разрешил сохранить подключение. После обновления потребуется ввести токен.';
  }

  return (
    <>
      <div className={styles.connectionBanner} role="status">
        <TriangleAlert size={18} aria-hidden="true" />
        <span>{message}</span>
        {phase === 'attention' && (
          <button
            className={ui.textButton}
            onClick={() => void runtime.retry()}
            disabled={skipping}
          >
            Повторить подключение
          </button>
        )}
        {phase === 'attention' && blockedNotificationId !== null && (
          <button
            className={ui.textButton}
            onClick={(event) => setSkipOpener(event.currentTarget)}
            disabled={skipping}
          >
            Пропустить уведомление
          </button>
        )}
        {phase === 'active' && notice && (
          <button className={ui.textButton} onClick={() => runtime.dismissNotice()}>
            Закрыть
          </button>
        )}
      </div>
      {skipOpener && blockedNotificationId !== null && (
        <Modal
          title="Пропустить уведомление?"
          onClose={() => setSkipOpener(null)}
          returnFocusTo={skipOpener}
        >
          <p className={ui.modalDescription}>
            Уведомление {blockedNotificationId} будет удалено из очереди без обработки. Если в нём
            было сообщение, оно не появится в этой переписке. Получение следующих уведомлений
            продолжится.
          </p>
          <div className={ui.modalActions}>
            <button className={ui.secondaryButton} onClick={() => setSkipOpener(null)}>
              Отмена
            </button>
            <button
              className={ui.primaryButton}
              onClick={() => {
                setSkipOpener(null);
                setSkipping(true);
                void runtime.skipInvalidNotification().finally(() => setSkipping(false));
              }}
            >
              Пропустить и продолжить
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
