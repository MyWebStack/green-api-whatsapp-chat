export type RequestState = 'sending' | 'accepted' | 'rejected' | 'unknown';
export const MAX_DATE_MS = 8_640_000_000_000_000;
export const MAX_MESSAGE_LENGTH = 20_000;
const DELETE_FOR_EVERYONE_MS = 60 * 60 * 60 * 1000;

export interface Message {
  localId: string;
  serverId?: string;
  chatId: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  createdAt: number;
  sequence: number;
  request: RequestState;
  error?: string;
  deleted?: boolean;
}

export function canDeleteFromWhatsApp(message: Message): boolean {
  return !message.deleted && message.direction === 'outgoing' && Boolean(message.serverId);
}

export function canDeleteForEveryone(message: Message, now: number): boolean {
  return canDeleteFromWhatsApp(message) && now - message.createdAt <= DELETE_FOR_EVERYONE_MS;
}

export interface Chat {
  id: string;
  name: string;
  phone?: string;
  activityAt: number;
  lastMessageId?: string;
  imported?: boolean;
  avatarUrl?: string;
  avatarCheckedAt?: number;
  unreadCount?: number;
  unreadUpdatedAt?: number;
  unreadSnapshotAt?: number;
  readAt?: number;
}

export interface RemoteChat {
  id: string;
  name: string;
  phone?: string;
  unreadCount?: number;
}

export interface Draft {
  text: string;
  version: number;
}

export interface ChatData {
  chats: Record<string, Chat>;
  messages: Record<string, Message>;
  drafts: Record<string, Draft>;
  selectedChatId: string | null;
  sequence: number;
}

export interface ChatMessageEvent {
  kind: 'message';
  serverId: string;
  chatId: string;
  name: string;
  phone?: string;
  text: string;
  direction: Message['direction'];
  at: number;
}

export type ChatEvent =
  | ChatMessageEvent
  | { kind: 'state'; state: string }
  | { kind: 'limit' }
  | { kind: 'ignore' }
  | { kind: 'invalid' };

export const emptyData = (): ChatData => ({
  chats: {},
  messages: {},
  drafts: {},
  selectedChatId: null,
  sequence: 0,
});

export function mergeChats(
  data: ChatData,
  remoteChats: RemoteChat[],
  now: number,
  requestedAt = now,
): ChatData {
  if (!remoteChats.length) return data;
  const chats = { ...data.chats };
  const byPhone = new Map(
    Object.values(chats)
      .filter((chat) => chat.phone)
      .map((chat) => [chat.phone, chat]),
  );

  remoteChats.forEach((remote, index) => {
    const known = chats[remote.id] ?? (remote.phone ? byPhone.get(remote.phone) : undefined);
    const activityAt = known?.lastMessageId
      ? known.activityAt
      : Math.max(known?.activityAt ?? 0, now - index);
    const preserveLocalUnread = Boolean(
      known?.unreadUpdatedAt && now - known.unreadUpdatedAt < 60_000,
    );
    const unreadCount = preserveLocalUnread
      ? known?.unreadCount
      : (remote.unreadCount ?? known?.unreadCount ?? 0);
    const unreadSnapshotAt =
      !preserveLocalUnread && remote.unreadCount !== undefined
        ? requestedAt
        : known?.unreadSnapshotAt;
    if (known) {
      chats[known.id] = {
        ...known,
        name: remote.name || known.name,
        phone: known.phone ?? remote.phone,
        activityAt,
        unreadCount,
        unreadSnapshotAt,
      };
    } else {
      chats[remote.id] = {
        id: remote.id,
        name: remote.name || (remote.phone ? `+${remote.phone}` : remote.id),
        phone: remote.phone,
        activityAt,
        imported: true,
        unreadCount,
        unreadSnapshotAt,
      };
    }
  });

  return { ...data, chats };
}

export function applyIncomingMessage(
  data: ChatData,
  event: ChatMessageEvent,
  newId: string,
  observedAt: number,
): ChatData {
  const updated = applyMessage(data, event, newId, observedAt);
  if (updated === data || event.direction !== 'incoming') return updated;
  const chatId = updated.messages[newId]?.chatId;
  if (!chatId) return updated;
  const chat = updated.chats[chatId];
  if (!chat) return updated;
  if (
    (chat.unreadSnapshotAt && event.at <= chat.unreadSnapshotAt) ||
    (chat.readAt && event.at <= chat.readAt)
  ) {
    return updated;
  }
  return {
    ...updated,
    chats: {
      ...updated.chats,
      [chatId]: {
        ...chat,
        unreadCount: (chat.unreadCount ?? 0) + 1,
        unreadUpdatedAt: observedAt,
      },
    },
  };
}

export function markMessagesRead(
  data: ChatData,
  chatId: string,
  count: number,
  now: number,
  requestedAt = now,
): ChatData {
  const chat = data.chats[chatId];
  if (!chat) return data;
  return {
    ...data,
    chats: {
      ...data.chats,
      [chatId]: {
        ...chat,
        unreadCount: Math.max(0, (chat.unreadCount ?? 0) - count),
        unreadUpdatedAt: now,
        readAt: requestedAt,
      },
    },
  };
}
export function normalizePhone(input: string): string {
  const phone = input.trim().replace(/[\s()+-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(phone)) {
    throw new Error('Введите номер с кодом страны, например +7 701 123-45-67.');
  }
  return phone;
}

export function validateText(text: string): string | null {
  if (!text.trim()) return 'Напишите сообщение.';
  if (text.length > MAX_MESSAGE_LENGTH) return `Сообщение длиннее ${MAX_MESSAGE_LENGTH} символов.`;
  return null;
}

export function sortedMessages(messages: ChatData['messages'], chatId: string): Message[] {
  return Object.values(messages)
    .filter((m) => m.chatId === chatId)
    .sort(compareMessages);
}

function compareMessages(a: Message, b: Message): number {
  // API timestamps are in seconds; local sends have millisecond precision.
  return Math.floor(a.createdAt / 1000) - Math.floor(b.createdAt / 1000) || a.sequence - b.sequence;
}

function recordLast(
  data: ChatData,
  chatId: string,
  message: Message,
  activityAt = message.createdAt,
): ChatData {
  const chat = data.chats[chatId];
  if (!chat) return data;
  const previous = chat.lastMessageId ? data.messages[chat.lastMessageId] : undefined;
  if (previous && compareMessages(previous, message) >= 0) return data;
  return {
    ...data,
    chats: {
      ...data.chats,
      [chatId]: { ...chat, lastMessageId: message.localId, activityAt },
    },
  };
}

function recomputeLast(data: ChatData, chatId: string): ChatData {
  const chat = data.chats[chatId];
  if (!chat) return data;
  const last = Object.values(data.messages)
    .filter((message) => message.chatId === chatId)
    .reduce<Message | undefined>(
      (latest, message) => (!latest || compareMessages(latest, message) < 0 ? message : latest),
      undefined,
    );
  if (!last || (chat.lastMessageId === last.localId && chat.activityAt === last.createdAt))
    return data;
  return {
    ...data,
    chats: {
      ...data.chats,
      [chatId]: { ...chat, lastMessageId: last.localId, activityAt: last.createdAt },
    },
  };
}

export function applyMessage(
  data: ChatData,
  event: ChatMessageEvent,
  newId: string,
  observedAt = event.at,
): ChatData {
  const knownChat =
    data.chats[event.chatId] ||
    (event.phone
      ? Object.values(data.chats).find((chat) => chat.phone === event.phone)
      : undefined);
  const chatId = knownChat?.id ?? event.chatId;
  const existing = Object.values(data.messages).find(
    (message) => message.chatId === chatId && message.serverId === event.serverId,
  );
  if (existing) return data;

  const message: Message = {
    localId: newId,
    serverId: event.serverId,
    chatId,
    direction: event.direction,
    text: event.text,
    createdAt: event.at,
    sequence: data.sequence + 1,
    request: 'accepted',
  };
  const next: ChatData = {
    ...data,
    sequence: message.sequence,
    chats: knownChat
      ? data.chats
      : {
          ...data.chats,
          [chatId]: {
            id: chatId,
            name: event.name || event.phone || event.chatId,
            phone: event.phone,
            activityAt: event.at,
          },
        },
    messages: { ...data.messages, [newId]: message },
  };
  return recordLast(next, chatId, message, observedAt);
}

export function beginSend(
  data: ChatData,
  options: {
    localId: string;
    chatId: string;
    text: string;
    draftVersion?: number;
    now: number;
  },
): ChatData {
  const error = validateText(options.text);
  if (error) throw new Error(error);
  if (!data.chats[options.chatId]) throw new Error('Чат не найден.');
  const message: Message = {
    localId: options.localId,
    chatId: options.chatId,
    direction: 'outgoing',
    text: options.text,
    createdAt: options.now,
    sequence: data.sequence + 1,
    request: 'sending',
  };
  const draft = data.drafts[options.chatId];
  const drafts =
    draft && options.draftVersion === draft.version
      ? { ...data.drafts, [options.chatId]: { text: '', version: draft.version + 1 } }
      : data.drafts;
  return recordLast(
    {
      ...data,
      sequence: message.sequence,
      messages: { ...data.messages, [options.localId]: message },
      drafts,
    },
    options.chatId,
    message,
  );
}

export function acceptSend(data: ChatData, localId: string, serverId: string): ChatData {
  const message = data.messages[localId];
  if (!message) return data;
  const updated = { ...message };
  const messages = { ...data.messages };
  const echo = Object.values(messages).find(
    (m) => m.localId !== localId && m.chatId === message.chatId && m.serverId === serverId,
  );
  if (echo) delete messages[echo.localId];
  updated.serverId = serverId;
  updated.request = 'accepted';
  delete updated.error;
  messages[localId] = updated;
  const result = { ...data, messages };
  return echo && data.chats[updated.chatId]?.lastMessageId === echo.localId
    ? recomputeLast(result, updated.chatId)
    : result;
}

export function failSend(
  data: ChatData,
  localId: string,
  request: 'unknown' | 'rejected',
  error: string,
): ChatData {
  const message = data.messages[localId];
  if (!message || message.request !== 'sending') return data;
  return {
    ...data,
    messages: {
      ...data.messages,
      [localId]: { ...message, request, error },
    },
  };
}

export function markMessageDeleted(data: ChatData, localId: string): ChatData {
  const message = data.messages[localId];
  if (!message || message.deleted || message.direction !== 'outgoing') return data;
  return {
    ...data,
    messages: {
      ...data.messages,
      [localId]: { ...message, text: '', deleted: true },
    },
  };
}
