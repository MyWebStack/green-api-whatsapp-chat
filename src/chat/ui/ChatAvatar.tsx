import { useState } from 'react';
import { useChatState } from '../../app/context';
import ui from '../../shared/styles/ui.module.scss';
import styles from './ChatAvatar.module.scss';

export function ChatAvatar({ name, chatId }: { name: string; chatId?: string }) {
  const avatarUrl = useChatState((state) =>
    chatId ? state.data.chats[chatId]?.avatarUrl : undefined,
  );
  const [failedUrl, setFailedUrl] = useState('');

  const words = name.trim().replace(/^[@+]/, '').split(/\s+/);
  const initials = (
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => Array.from(word)[0])
          .join('')
      : Array.from(words[0] ?? '')
          .slice(0, 2)
          .join('')
  ).toLocaleUpperCase('ru');

  return (
    <span className={ui.avatar} aria-hidden="true">
      {avatarUrl && avatarUrl !== failedUrl ? (
        <img
          className={styles.image}
          src={avatarUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
