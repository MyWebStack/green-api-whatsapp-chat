import { useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare, Plus } from 'lucide-react';
import { useChatState, useRuntime } from '../../app/context';
import { canSend } from '../application/runtime';
import { Modal } from '../../shared/ui/Modal';
import { ChatPane } from './ChatPane';
import { CreateChat } from './CreateChat';
import { Sidebar } from './Sidebar';
import { ConnectionBanner } from './ConnectionBanner';
import ui from '../../shared/styles/ui.module.scss';
import styles from './ChatShell.module.scss';

export function ChatShell() {
  const runtime = useRuntime();
  const selected = useChatState((s) => s.data.selectedChatId);
  const ready = useChatState(canSend);
  const phase = useChatState((s) => s.phase);
  const sidebarRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const chatTitleRef = useRef<HTMLHeadingElement>(null);
  const previousSelection = useRef(selected);
  const [modal, setModal] = useState<{
    kind: 'new' | 'logout';
    opener: HTMLElement;
  } | null>(null);
  const openModal = (kind: 'new' | 'logout', opener: HTMLElement) => {
    setModal({ kind, opener });
  };

  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selected;
    if (previous === selected) return;

    const target =
      selected && sidebarRef.current?.getClientRects().length === 0
        ? chatTitleRef.current
        : previous && !selected && conversationRef.current?.getClientRects().length === 0
          ? listTitleRef.current
          : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  return (
    <main className={styles.workspace}>
      <Sidebar
        ref={sidebarRef}
        titleRef={listTitleRef}
        onCreate={(opener) => openModal('new', opener)}
        onLogout={(opener) => openModal('logout', opener)}
      />
      <div
        ref={conversationRef}
        className={`${styles.conversationColumn} ${!selected ? styles.columnHidden : ''}`}
      >
        <ConnectionBanner />
        {selected ? (
          <ChatPane key={selected} chatId={selected} titleRef={chatTitleRef} />
        ) : (
          <section className={styles.welcome}>
            <div className={styles.welcomeIllustration}>
              <MessageSquare size={48} />
            </div>
            <p>
              Выберите чат слева или начните новую
              <br />
              переписку по номеру телефона.
            </p>
            <button
              className={ui.primaryButton}
              onClick={(event) => openModal('new', event.currentTarget)}
              disabled={!ready}
            >
              <Plus size={18} />
              Новый чат
            </button>
            <span className={styles.welcomeFootnote}>Текстовые сообщения · WhatsApp</span>
          </section>
        )}
      </div>
      {modal?.kind === 'new' && (
        <CreateChat
          onClose={() => setModal(null)}
          returnFocusTo={modal.opener}
          focusAfterCreate={chatTitleRef}
        />
      )}
      {modal?.kind === 'logout' && (
        <Modal
          title="Выйти из приложения?"
          onClose={() => setModal(null)}
          returnFocusTo={modal.opener}
        >
          <p className={ui.modalDescription}>
            Подключение будет завершено во всех вкладках. Сообщения в WhatsApp останутся.
          </p>
          <div className={ui.modalActions}>
            <button className={ui.secondaryButton} onClick={() => setModal(null)}>
              Отмена
            </button>
            <button
              className={ui.primaryButton}
              disabled={phase === 'closing'}
              onClick={() => {
                setModal(null);
                void runtime.logout();
              }}
            >
              Выйти
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
