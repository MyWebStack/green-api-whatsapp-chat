import { useState } from 'react';
import { ChatAvatar } from './ChatAvatar';
import ui from '../../shared/styles/ui.module.scss';
import styles from './AccountAvatar.module.scss';

export function AccountAvatar({ url, accountId }: { url: string; accountId: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <ChatAvatar name={accountId.split('@')[0] || 'WA'} />;

  return (
    <img
      className={`${ui.avatar} ${styles.image}`}
      src={url}
      alt="Фото профиля WhatsApp"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
