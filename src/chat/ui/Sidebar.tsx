import { useLayoutEffect, useMemo, useRef, useState, type Ref, type UIEvent } from 'react';
import { LogOut, MessageSquare, Plus, Search } from 'lucide-react';
import { useChatState, useRuntime } from '../../app/context';
import { canSend } from '../application/runtime';
import { ChatListItem } from './ChatListItem';
import { AccountAvatar } from './AccountAvatar';
import ui from '../../shared/styles/ui.module.scss';
import styles from './Sidebar.module.scss';

const CHAT_PAGE_SIZE = 100;

export function Sidebar({
  ref,
  titleRef,
  onCreate,
  onLogout,
}: {
  ref: Ref<HTMLElement>;
  titleRef: Ref<HTMLHeadingElement>;
  onCreate(opener: HTMLElement): void;
  onLogout(opener: HTMLElement): void;
}) {
  const runtime = useRuntime();
  const chats = useChatState((s) => s.data.chats);
  const messages = useChatState((s) => s.data.messages);
  const historyStatus = useChatState((s) => s.historyStatus);
  const selected = useChatState((s) => s.data.selectedChatId);
  const instance = useChatState((s) => s.instanceId);
  const accountId = useChatState((s) => s.accountId);
  const avatar = useChatState((s) => s.accountAvatar);
  const chatListStatus = useChatState((s) => s.chatListStatus);
  const ready = useChatState(canSend);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(CHAT_PAGE_SIZE);
  const listRef = useRef<HTMLElement>(null);
  const sortedChats = useMemo(
    () =>
      Object.values(chats).sort(
        (a, b) =>
          Number(Boolean(b.lastMessageId && messages[b.lastMessageId])) -
            Number(Boolean(a.lastMessageId && messages[a.lastMessageId])) ||
          b.activityAt - a.activityAt ||
          a.id.localeCompare(b.id),
      ),
    [chats, messages],
  );
  const visibleChats = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('ru');
    if (!term) return sortedChats;
    const digits = term.replace(/\D/g, '');
    return sortedChats.filter(
      (chat) =>
        chat.name.toLocaleLowerCase('ru').includes(term) ||
        (digits.length > 0 && chat.phone?.includes(digits)),
    );
  }, [query, sortedChats]);
  const renderedChats = visibleChats.slice(0, visibleCount);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (
      list &&
      list.clientHeight > 0 &&
      list.scrollHeight <= list.clientHeight &&
      visibleCount < visibleChats.length
    ) {
      setVisibleCount((count) => Math.min(count + CHAT_PAGE_SIZE, visibleChats.length));
    }
  }, [selected, visibleChats.length, visibleCount]);

  function handleSearch(value: string) {
    setQuery(value);
    setVisibleCount(CHAT_PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  function handleListScroll(event: UIEvent<HTMLElement>) {
    const list = event.currentTarget;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) {
      setVisibleCount((count) => Math.min(count + CHAT_PAGE_SIZE, visibleChats.length));
    }
  }
  return (
    <aside
      ref={ref}
      className={`${styles.sidebar} ${selected ? styles.sidebarHidden : ''}`}
      aria-label="Чаты"
    >
      <header className={styles.sidebarHeader}>
        <span className={ui.brand}>
          <span className={ui.logo}>
            <MessageSquare size={21} />
          </span>
          Диалог
        </span>
        <button
          className={ui.iconButton}
          aria-label="Выйти"
          title="Выйти"
          onClick={(event) => onLogout(event.currentTarget)}
        >
          <LogOut />
        </button>
      </header>
      <div className={styles.sidebarTitle}>
        <h1 ref={titleRef} tabIndex={-1}>
          Чаты <span>{sortedChats.length}</span>
        </h1>
        <button
          className={styles.newChatButton}
          aria-label="Новый чат"
          title="Новый чат"
          onClick={(event) => onCreate(event.currentTarget)}
          disabled={!ready}
        >
          <Plus size={20} />
        </button>
      </div>
      <label className={styles.chatSearch}>
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          aria-label="Поиск по чатам"
          placeholder="Поиск по имени или номеру"
          value={query}
          onChange={(event) => handleSearch(event.target.value)}
        />
      </label>
      <nav
        ref={listRef}
        className={styles.chatList}
        aria-label="Список чатов"
        onScroll={handleListScroll}
      >
        {chatListStatus === 'loading' && (
          <p className={styles.chatListNotice}>Загружаем последние чаты…</p>
        )}
        {chatListStatus === 'error' && (
          <div className={styles.chatListNotice}>
            <p>Не удалось загрузить последние чаты.</p>
            <button className={ui.textButton} onClick={() => void runtime.refreshChats()}>
              Повторить
            </button>
          </div>
        )}
        {renderedChats.map((chat) => {
          const lastMessage = chat.lastMessageId ? messages[chat.lastMessageId] : undefined;
          return (
            <ChatListItem
              key={chat.id}
              chat={chat}
              lastMessage={lastMessage}
              historyStatus={historyStatus[chat.id]}
              selected={selected === chat.id}
            />
          );
        })}
        {query.trim() && !visibleChats.length && sortedChats.length > 0 && (
          <p className={styles.chatListNotice}>Чаты не найдены.</p>
        )}
        {!sortedChats.length && chatListStatus !== 'loading' && (
          <div className={styles.emptyList}>
            <p>Здесь будут ваши чаты</p>
            <span>Начните переписку по номеру телефона.</span>
            <button
              className={ui.textButton}
              onClick={(event) => onCreate(event.currentTarget)}
              disabled={!ready}
            >
              Создать первый чат
            </button>
          </div>
        )}
      </nav>
      <footer className={styles.sidebarFooter}>
        <AccountAvatar key={avatar} url={avatar} accountId={accountId} />
        <div className={styles.accountDetails}>
          WhatsApp через GREEN-API
          <small>
            Инстанс {instance} · {ready ? 'на связи' : 'нет соединения'}
          </small>
        </div>
        <span
          className={`${styles.statusDot} ${ready ? '' : styles.statusDotInactive}`}
          aria-hidden="true"
        />
      </footer>
    </aside>
  );
}
