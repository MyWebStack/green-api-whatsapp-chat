import { MessageSquare } from 'lucide-react';
import { useChatState } from '../app/context';
import ui from '../shared/styles/ui.module.scss';
import styles from './ConnectScreen.module.scss';
import { ConnectionForm } from './ConnectionForm';

export function ConnectScreen() {
  const phase = useChatState((s) => s.phase);
  const notice = useChatState((s) => s.notice);
  const busy = phase === 'connecting' || phase === 'closing';

  return (
    <div className={styles.connectPage}>
      <header className={styles.landingHeader}>
        <a className={ui.brand} href={import.meta.env.BASE_URL}>
          <span className={ui.logo}>
            <MessageSquare size={23} />
          </span>
          Диалог
        </a>
        <span className={styles.serviceLabel}>
          WhatsApp <span>через GREEN-API</span>
        </span>
      </header>
      <main className={styles.connectMain}>
        <div className={styles.connectCard}>
          <span className={styles.connectSymbol}>
            <MessageSquare size={30} />
          </span>
          <h1>Начните диалог</h1>
          <p className={styles.intro}>
            Подключите WhatsApp-инстанс GREEN-API,
            <br className={styles.desktopBreak} /> чтобы отправлять и получать сообщения.
          </p>
          <ConnectionForm busy={busy} notice={notice} />
          <p className={styles.credentialsHint}>
            Параметры подключения находятся в{' '}
            <a href="https://console.green-api.com/" target="_blank" rel="noopener noreferrer">
              личном кабинете GREEN-API
            </a>
            .
          </p>
          <a
            className={styles.setupLink}
            href="https://green-api.com/docs/before-start/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Как настроить инстанс <span aria-hidden="true">↗</span>
          </a>
        </div>
      </main>
    </div>
  );
}
