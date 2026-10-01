import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { ChevronDown, ChevronLeft, MessageSquare, Trash2 } from 'lucide-react';
import { useChatState, useRuntime } from '../../app/context';
import { canSend } from '../application/runtime';
import {
  canDeleteFromWhatsApp,
  canDeleteForEveryone,
  sortedMessages,
  type Message,
} from '../domain/model';
import { Modal } from '../../shared/ui/Modal';
import { ChatAvatar } from './ChatAvatar';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import ui from '../../shared/styles/ui.module.scss';
import styles from './ChatPane.module.scss';

const calendar = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' });

function dateLabel(timestamp: number) {
  const date = new Date(timestamp);
  return date.toDateString() === new Date().toDateString() ? 'Сегодня' : calendar.format(date);
}

function startsNewDay(message: Message, previous?: Message): boolean {
  return (
    !previous ||
    new Date(message.createdAt).toDateString() !== new Date(previous.createdAt).toDateString()
  );
}

export function ChatPane({
  chatId,
  titleRef,
}: {
  chatId: string;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const runtime = useRuntime();
  const chat = useChatState((s) => s.data.chats[chatId]);
  const messageRecords = useChatState((s) => s.data.messages);
  const messages = useMemo(() => sortedMessages(messageRecords, chatId), [messageRecords, chatId]);
  const [windowEnd, setWindowEnd] = useState(messages.length);
  const [visibleCount, setVisibleCount] = useState(100);
  const firstVisible = Math.max(0, Math.min(windowEnd, messages.length) - visibleCount);
  const visibleMessages = messages.slice(firstVisible, Math.min(windowEnd, messages.length));
  const ready = useChatState((s) => canSend(s) && !s.busyChats[chatId]);
  const phase = useChatState((s) => s.phase);
  const historyStatus = useChatState((s) => s.historyStatus[chatId]);
  const viewport = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const pinnedToBottom = useRef(true);
  const previousMessageCount = useRef<number | null>(null);
  const pendingPrepend = useRef<{ height: number; top: number } | null>(null);
  const jumpToLatestRequested = useRef(false);
  const [scrollRequest, setScrollRequest] = useState(0);
  const [unseen, setUnseen] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    type: 'retry' | 'restore';
    message: Message;
    opener: HTMLElement;
  } | null>(null);
  const [actionError, setActionError] = useState('');
  const [menu, setMenu] = useState<{
    message: Message;
    x: number;
    y: number;
    opener: HTMLElement;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [deletion, setDeletion] = useState<{
    message: Message;
    forEveryone: boolean;
    opener: HTMLElement;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => {
    if (phase !== 'active') return;
    void runtime.loadChatHistory(chatId);
    runtime.loadChatAvatar(chatId);
    runtime.markChatRead(chatId);
  }, [chatId, phase, runtime]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector('button')?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(null);
      menu.opener.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  function handleScroll() {
    const node = viewport.current;
    if (!node) return;
    const atBottom =
      windowEnd === messages.length && node.scrollHeight - node.scrollTop - node.clientHeight < 64;
    pinnedToBottom.current = atBottom;
    if (atBottom) setUnseen(false);
  }

  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (pendingPrepend.current) {
      node.scrollTop =
        pendingPrepend.current.top + node.scrollHeight - pendingPrepend.current.height;
      pendingPrepend.current = null;
    } else if (jumpToLatestRequested.current) {
      node.scrollTop = node.scrollHeight;
      pinnedToBottom.current = true;
      jumpToLatestRequested.current = false;
    } else if (previousMessageCount.current === null) {
      node.scrollTop = node.scrollHeight;
      pinnedToBottom.current = true;
    } else if (messages.length > previousMessageCount.current) {
      if (pinnedToBottom.current && windowEnd !== messages.length) {
        setWindowEnd(messages.length);
        return;
      }
      if (pinnedToBottom.current) node.scrollTop = node.scrollHeight;
      else setUnseen(true);
    } else if (windowEnd > messages.length) {
      setWindowEnd(messages.length);
    }
    previousMessageCount.current = messages.length;
  }, [messages.length, scrollRequest, visibleCount, windowEnd]);

  function showEarlierMessages() {
    const node = viewport.current;
    if (node) pendingPrepend.current = { height: node.scrollHeight, top: node.scrollTop };
    pinnedToBottom.current = false;
    setVisibleCount((count) => count + 100);
  }

  function showLatestMessages() {
    jumpToLatestRequested.current = true;
    setWindowEnd(messages.length);
    setVisibleCount(100);
    setUnseen(false);
    setScrollRequest((request) => request + 1);
  }

  async function retryMessage(message: Message) {
    try {
      await runtime.send(message.chatId, message.text);
      setActionError('');
    } catch (issue) {
      setActionError(issue instanceof Error ? issue.message : 'Не удалось повторить отправку.');
    }
  }

  function restoreMessage(message: Message) {
    runtime.setDraft(chatId, message.text);
    composer.current?.focus();
  }

  function handleRetry(message: Message, opener: HTMLElement) {
    if (message.request === 'unknown') {
      setConfirmation({ type: 'retry', message, opener });
    } else {
      void retryMessage(message);
    }
  }

  function handleRestore(message: Message, opener: HTMLElement) {
    if (runtime.store.getState().drafts[chatId]?.text) {
      setConfirmation({ type: 'restore', message, opener });
    } else {
      restoreMessage(message);
    }
  }

  function confirmDelete(forEveryone: boolean) {
    if (!menu) return;
    setDeletion({ message: menu.message, forEveryone, opener: menu.opener });
    setDeleteError('');
    setMenu(null);
  }

  async function deleteMessage() {
    if (!deletion || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await runtime.deleteMessage(deletion.message.localId, deletion.forEveryone);
      setDeletion(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Не удалось удалить сообщение.');
    } finally {
      setDeleting(false);
    }
  }

  if (!chat) return null;
  return (
    <section className={styles.chatPane} aria-label={`Переписка с ${chat.name}`}>
      <header className={styles.chatHeader}>
        <button
          className={`${ui.iconButton} ${styles.mobileBack}`}
          aria-label="К списку чатов"
          onClick={() => void runtime.selectChat(null)}
        >
          <ChevronLeft />
        </button>
        <ChatAvatar name={chat.name} chatId={chat.id} />
        <div>
          <h2 ref={titleRef} tabIndex={-1}>
            {chat.name}
          </h2>
          <p>{chat.phone && chat.name !== `+${chat.phone}` ? `+${chat.phone} · ` : ''}WhatsApp</p>
        </div>
      </header>
      <div
        ref={viewport}
        className={styles.messageViewport}
        onScroll={handleScroll}
        role="log"
        aria-label="Сообщения"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {historyStatus === 'loading' && (
          <p className={styles.historyNotice}>Загружаем историю сообщений…</p>
        )}
        {historyStatus === 'error' && (
          <div className={styles.historyNotice}>
            <p>Не удалось загрузить историю сообщений.</p>
            <button className={ui.textButton} onClick={() => void runtime.loadChatHistory(chatId)}>
              Повторить
            </button>
          </div>
        )}
        {!messages.length && historyStatus !== 'loading' && historyStatus !== 'error' && (
          <div className={styles.emptyConversation}>
            <span className={styles.emptyIcon}>
              <MessageSquare size={30} />
            </span>
            <h3>Начните разговор</h3>
            <p>
              {chat.imported
                ? 'Доступных текстовых сообщений пока нет. Вы можете написать собеседнику первым.'
                : 'Ваше первое сообщение появится здесь.'}
            </p>
          </div>
        )}
        {firstVisible > 0 && (
          <button type="button" className={styles.olderMessages} onClick={showEarlierMessages}>
            Показать предыдущие сообщения
          </button>
        )}
        {visibleMessages.map((message, index) => (
          <div key={message.localId}>
            {startsNewDay(message, visibleMessages[index - 1]) && (
              <div className={styles.dateDivider}>
                <span>{dateLabel(message.createdAt)}</span>
              </div>
            )}
            <MessageBubble
              message={message}
              senderName={chat.name}
              ready={ready}
              onRetry={handleRetry}
              onRestore={handleRestore}
              onOpenActions={(message, x, y, opener) => setMenu({ message, x, y, opener })}
            />
          </div>
        ))}
      </div>
      {unseen && (
        <button className={styles.newMessages} onClick={showLatestMessages}>
          Новые сообщения <ChevronDown size={16} />
        </button>
      )}
      {actionError && (
        <p role="alert" className={ui.composerError}>
          {actionError}
        </p>
      )}
      {menu && (
        <div
          ref={menuRef}
          className={styles.messageMenu}
          role="group"
          aria-label="Действия с сообщением"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 110)),
          }}
        >
          <button type="button" onClick={() => confirmDelete(false)} disabled={!ready}>
            <Trash2 size={16} />
            {canDeleteFromWhatsApp(menu.message) ? 'Удалить у себя' : 'Удалить из приложения'}
          </button>
          {canDeleteForEveryone(menu.message, Date.now()) && (
            <button type="button" onClick={() => confirmDelete(true)} disabled={!ready}>
              <Trash2 size={16} />
              Удалить у всех
            </button>
          )}
        </div>
      )}
      <Composer chatId={chatId} inputRef={composer} />
      {deletion && (
        <Modal
          title="Удалить сообщение?"
          onClose={() => {
            if (!deleting) setDeletion(null);
          }}
          returnFocusTo={deletion.opener}
        >
          <p className={ui.modalDescription}>
            {deletion.forEveryone
              ? 'Сообщение будет удалено у всех участников WhatsApp. Это действие нельзя отменить.'
              : canDeleteFromWhatsApp(deletion.message)
                ? 'Сообщение будет удалено только у вас. У собеседника оно останется.'
                : 'Сообщение будет скрыто в этом приложении. Переписка в WhatsApp не изменится.'}
          </p>
          {deleteError && (
            <p className={ui.formError} role="alert">
              {deleteError}
            </p>
          )}
          <div className={ui.modalActions}>
            <button
              className={ui.secondaryButton}
              onClick={() => setDeletion(null)}
              disabled={deleting}
            >
              Отмена
            </button>
            <button
              className={ui.primaryButton}
              onClick={() => void deleteMessage()}
              disabled={deleting}
            >
              {deleting ? 'Удаляем…' : 'Удалить'}
            </button>
          </div>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={confirmation.type === 'retry' ? 'Повторить отправку?' : 'Заменить черновик?'}
          onClose={() => setConfirmation(null)}
          returnFocusTo={confirmation.opener}
        >
          <p className={ui.modalDescription}>
            {confirmation.type === 'retry'
              ? 'Ответ сервиса не был получен. Сообщение могло дойти до собеседника — повторная отправка может создать дубль.'
              : 'В поле ввода уже есть текст. Заменить его выбранным сообщением?'}
          </p>
          <div className={ui.modalActions}>
            <button className={ui.secondaryButton} onClick={() => setConfirmation(null)}>
              Отмена
            </button>
            <button
              className={ui.primaryButton}
              onClick={() => {
                const action = confirmation;
                setConfirmation(null);
                if (action.type === 'retry') void retryMessage(action.message);
                else restoreMessage(action.message);
              }}
            >
              {confirmation.type === 'retry' ? 'Отправить ещё раз' : 'Заменить'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
