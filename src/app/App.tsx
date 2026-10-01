import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { ChatRuntime } from '../chat/application/runtime';
import { ChatShell } from '../chat/ui/ChatShell';
import { ConnectScreen } from '../session/ConnectScreen';
import { RuntimeContext } from './context';

const APP_TITLE = 'Диалог — WhatsApp через GREEN-API';

export function App({ runtime }: { runtime: ChatRuntime }) {
  const showChat = useStore(
    runtime.store,
    ({ accountId, phase }) => Boolean(accountId) && phase !== 'signedOut',
  );

  const unreadCount = useStore(runtime.store, ({ data, accountId, phase }) =>
    accountId && phase !== 'signedOut'
      ? Object.values(data.chats).reduce((total, chat) => total + (chat.unreadCount ?? 0), 0)
      : 0,
  );

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) ${APP_TITLE}` : APP_TITLE;
    return () => {
      document.title = APP_TITLE;
    };
  }, [unreadCount]);

  useEffect(() => {
    const unmountRuntime = runtime.mount();

    const handleNetworkChange = () => {
      runtime.connectivityChanged();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') runtime.resume();
    };

    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unmountRuntime();
    };
  }, [runtime]);

  return (
    <RuntimeContext value={runtime}>{showChat ? <ChatShell /> : <ConnectScreen />}</RuntimeContext>
  );
}
