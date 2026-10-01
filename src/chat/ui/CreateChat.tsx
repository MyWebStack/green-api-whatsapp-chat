import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowRight } from 'lucide-react';
import { useRuntime } from '../../app/context';
import { MAX_MESSAGE_LENGTH } from '../domain/model';
import { Modal } from '../../shared/ui/Modal';
import ui from '../../shared/styles/ui.module.scss';
import styles from './CreateChat.module.scss';

export function CreateChat({
  onClose,
  returnFocusTo,
  focusAfterCreate,
}: {
  onClose(): void;
  returnFocusTo?: HTMLElement | null;
  focusAfterCreate?: RefObject<HTMLElement | null>;
}) {
  const runtime = useRuntime();
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [step, setStep] = useState<'idle' | 'checking' | 'sending'>('idle');
  const busy = step !== 'idle';
  const [error, setError] = useState('');
  const pendingRequest = useRef<AbortController | null>(null);
  const focusTarget = useRef<HTMLElement | null>(returnFocusTo ?? null);

  useEffect(() => () => pendingRequest.current?.abort(), []);

  function close() {
    pendingRequest.current?.abort();
    onClose();
  }

  async function createChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }

    setStep('checking');
    setError('');
    const request = new AbortController();
    pendingRequest.current = request;

    try {
      const chatId = await runtime.createChat(phone, request.signal);
      if (request.signal.aborted) return;
      if (message.trim()) {
        setStep('sending');
        await runtime.send(chatId, message);
      }
      if (request.signal.aborted) return;
      focusTarget.current = focusAfterCreate?.current ?? null;
      onClose();
    } catch (issue) {
      if (!request.signal.aborted) {
        setError(issue instanceof Error ? issue.message : 'Не удалось создать чат.');
      }
    } finally {
      if (pendingRequest.current === request) pendingRequest.current = null;
      if (!request.signal.aborted) setStep('idle');
    }
  }

  return (
    <Modal title="Новый чат" onClose={close} returnFocusTo={focusTarget}>
      <p className={ui.modalDescription}>Введите номер собеседника в WhatsApp с кодом страны.</p>
      <form onSubmit={(event) => void createChat(event)}>
        <label className={ui.field}>
          Номер телефона
          <input
            autoFocus
            type="tel"
            autoComplete="tel"
            placeholder="+7 701 123-45-67"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label className={`${ui.field} ${styles.firstMessage}`}>
          Первое сообщение (опционально)
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Напишите сообщение…"
            rows={3}
            maxLength={MAX_MESSAGE_LENGTH}
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className={`${ui.formError} ${ui.modalError}`}>
            {error}
          </p>
        )}
        <div className={ui.modalActions}>
          <button type="button" className={ui.secondaryButton} onClick={close}>
            Отмена
          </button>
          <button type="submit" className={ui.primaryButton} disabled={busy}>
            {step === 'checking'
              ? 'Проверяем…'
              : step === 'sending'
                ? 'Отправляем…'
                : message.trim()
                  ? 'Создать и отправить'
                  : 'Создать чат'}
            <ArrowRight size={18} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
