import type { LastChatStorage } from '../chat/application/ports';

const keyOf = (accountKey: string) => `dialog.last-chat:${accountKey}`;

export const lastChatStorage: LastChatStorage = {
  read(accountKey) {
    try {
      const chatId = localStorage.getItem(keyOf(accountKey));
      return chatId && /^\d+@(c\.us|lid)$/.test(chatId) ? chatId : null;
    } catch {
      return null;
    }
  },
  write(accountKey, chatId) {
    try {
      localStorage.setItem(keyOf(accountKey), chatId);
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  },
};
