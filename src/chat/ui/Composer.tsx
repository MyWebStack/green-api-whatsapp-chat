import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { Clock3, SendHorizontal } from 'lucide-react';
import { useChatState, useRuntime } from '../../app/context';
import { canSend } from '../application/runtime';
import { MAX_MESSAGE_LENGTH } from '../domain/model';
import ui from '../../shared/styles/ui.module.scss';
import styles from './Composer.module.scss';

export function Composer({
  chatId,
  inputRef,
}: {
  chatId: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const runtime = useRuntime();
  const draft = useChatState((s) => s.drafts[chatId]);
  const ready = useChatState(canSend);
  const busy = useChatState((s) => Boolean(s.busyChats[chatId]));
  const text = draft?.text ?? '';
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight}px`;
    }
  }, [inputRef, text]);

  async function send() {
    if (!text.trim() || busy || !ready || text.length > MAX_MESSAGE_LENGTH) return;
    setError('');
    inputRef.current?.focus();
    try {
      await runtime.send(chatId);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Не удалось отправить сообщение.');
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }

    event.preventDefault();
    void send();
  }

  return (
    <div className={styles.composerArea}>
      {error && (
        <p role="alert" className={ui.composerError}>
          {error}
        </p>
      )}
      <form
        className={styles.composer}
        aria-label="Отправка сообщения"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          aria-label="Сообщение"
          placeholder="Напишите сообщение…"
          rows={1}
          value={text}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(e) => runtime.setDraft(chatId, e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          className={styles.sendButton}
          aria-label="Отправить сообщение"
          title={!ready ? 'Дождитесь соединения' : 'Отправить сообщение'}
          disabled={!ready || busy || !text.trim() || text.length > MAX_MESSAGE_LENGTH}
        >
          {busy ? <Clock3 size={22} /> : <SendHorizontal size={22} />}
        </button>
      </form>
      <div className={styles.composerHint}>
        <span>
          {!ready
            ? 'Можно писать — отправка станет доступна после подключения'
            : 'Enter — отправить · Shift + Enter — новая строка'}
        </span>
        {text.length > MAX_MESSAGE_LENGTH * 0.9 && (
          <span aria-live="polite">
            {text.length} / {MAX_MESSAGE_LENGTH}
          </span>
        )}
      </div>
    </div>
  );
}
