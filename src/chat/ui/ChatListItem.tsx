import { useRuntime } from '../../app/context';
import type { Chat, Message } from '../domain/model';
import { ChatAvatar } from './ChatAvatar';
import styles from './ChatListItem.module.scss';

const timeFormatter = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' });
const dateWithYearFormatter = new Intl.DateTimeFormat('ru', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function activityLabel(timestamp: number) {
  const activity = new Date(timestamp);
  const today = new Date();
  if (activity.toDateString() === today.toDateString()) return timeFormatter.format(activity);
  return activity.getFullYear() === today.getFullYear()
    ? dateFormatter.format(activity)
    : dateWithYearFormatter.format(activity);
}

function previewLabel(
  chat: Chat,
  lastMessage?: Message,
  historyStatus?: 'loading' | 'ready' | 'error',
) {
  if (lastMessage) {
    if (lastMessage.deleted) return 'Сообщение удалено';
    return `${lastMessage.direction === 'outgoing' ? 'Вы: ' : ''}${lastMessage.text}`;
  }
  if (!chat.imported) return 'Сообщений пока нет';
  if (historyStatus === 'loading') return 'Загружаем сообщения…';
  if (historyStatus === 'ready') return 'Текстовых сообщений нет';
  if (historyStatus === 'error') return 'Не удалось загрузить историю';
  return 'Откройте чат, чтобы загрузить сообщения';
}

export function ChatListItem({
  chat,
  lastMessage,
  historyStatus,
  selected,
}: {
  chat: Chat;
  lastMessage?: Message;
  historyStatus?: 'loading' | 'ready' | 'error';
  selected: boolean;
}) {
  const runtime = useRuntime();

  return (
    <button
      className={`${styles.chatItem} ${selected ? styles.selectedChat : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => void runtime.selectChat(chat.id)}
    >
      <ChatAvatar name={chat.name} chatId={chat.id} />
      <span className={styles.chatItemContent}>
        <span className={styles.chatItemTop}>
          <strong>{chat.name}</strong>
          {lastMessage && (
            <time dateTime={new Date(lastMessage.createdAt).toISOString()}>
              {activityLabel(lastMessage.createdAt)}
            </time>
          )}
        </span>
        <span className={styles.chatItemBottom}>
          <span className={styles.chatPreview}>
            {previewLabel(chat, lastMessage, historyStatus)}
          </span>
          {!!chat.unreadCount && (
            <span
              className={styles.unreadBadge}
              role="img"
              aria-label={`Непрочитанных сообщений: ${chat.unreadCount}`}
            >
              {chat.unreadCount > 99 ? '99+' : chat.unreadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
