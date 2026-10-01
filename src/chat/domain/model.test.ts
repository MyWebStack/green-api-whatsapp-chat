import { describe, expect, it } from 'vitest';
import {
  acceptSend,
  applyIncomingMessage,
  applyMessage,
  beginSend,
  canDeleteForEveryone,
  emptyData,
  MAX_MESSAGE_LENGTH,
  markMessageDeleted,
  mergeChats,
  markMessagesRead,
  normalizePhone,
  sortedMessages,
  validateText,
  type ChatMessageEvent,
} from './model';

const incoming = (overrides: Partial<ChatMessageEvent> = {}): ChatMessageEvent => ({
  kind: 'message',
  serverId: '9007199254740993001',
  chatId: '123',
  name: 'Анна',
  text: 'Привет',
  at: 1000,
  direction: 'incoming',
  ...overrides,
});

const chat = () => ({
  ...emptyData(),
  chats: { '123': { id: '123', name: 'Анна', activityAt: 0 } },
});

describe('message invariants', () => {
  it('keeps a deleted message as a tombstone so history cannot restore its text', () => {
    const saved = applyMessage(emptyData(), incoming({ direction: 'outgoing' }), 'local-1');
    const deleted = markMessageDeleted(saved, 'local-1');
    const replayed = applyMessage(deleted, incoming({ direction: 'outgoing' }), 'local-2');

    expect(deleted.messages['local-1']).toMatchObject({ text: '', deleted: true });
    expect(replayed).toBe(deleted);
    const received = applyMessage(emptyData(), incoming(), 'incoming-1');
    expect(markMessageDeleted(received, 'incoming-1')).toBe(received);
  });

  it('offers deletion for everyone only for recent outgoing messages with a server ID', () => {
    const message = {
      localId: 'local-1',
      serverId: 'server-1',
      chatId: '123',
      direction: 'outgoing' as const,
      text: 'Привет',
      createdAt: 100_000,
      sequence: 1,
      request: 'accepted' as const,
    };
    const now = message.createdAt + 60 * 60 * 60 * 1000;

    expect(canDeleteForEveryone(message, now)).toBe(true);
    expect(canDeleteForEveryone(message, now + 1)).toBe(false);
    expect(canDeleteForEveryone({ ...message, direction: 'incoming' }, now)).toBe(false);
    expect(canDeleteForEveryone({ ...message, serverId: undefined }, now)).toBe(false);
  });
  it('merges recent WhatsApp chats without losing local messages or drafts', () => {
    const data = {
      ...chat(),
      drafts: { '123': { text: 'Черновик', version: 1 } },
    };
    const merged = mergeChats(
      data,
      [
        { id: '77011234567@c.us', name: 'Айгуль', phone: '77011234567' },
        { id: '123', name: 'Анна' },
      ],
      100_000,
    );

    expect(Object.keys(merged.chats)).toEqual(['123', '77011234567@c.us']);
    expect(merged.chats['77011234567@c.us']).toMatchObject({
      name: 'Айгуль',
      imported: true,
    });
    expect(merged.chats['123']?.activityAt).toBe(99_999);
    expect(merged.drafts['123']?.text).toBe('Черновик');
  });

  it('keeps a newer local message above a stale chat-list response', () => {
    const data = applyMessage(
      emptyData(),
      incoming({ chatId: '77011234567@c.us', at: 101_000 }),
      'local-1',
    );
    const merged = mergeChats(
      data,
      [{ id: '77011234567@c.us', name: 'Айгуль', phone: '77011234567' }],
      102_000,
    );

    expect(merged.chats['77011234567@c.us']?.activityAt).toBe(101_000);
    expect(merged.chats['77011234567@c.us']?.lastMessageId).toBe('local-1');
  });

  it('does not count queued notifications already covered by GetChats', () => {
    const id = '77011234567@c.us';
    const fromApi = mergeChats(emptyData(), [{ id, name: 'Анна', unreadCount: 2 }], 100_000);
    const queued = applyIncomingMessage(
      fromApi,
      incoming({ chatId: id, at: 99_000 }),
      'queued',
      101_000,
    );
    const fresh = applyIncomingMessage(
      queued,
      incoming({ chatId: id, serverId: 'new', at: 102_000 }),
      'fresh',
      102_000,
    );

    expect(queued.chats[id]?.unreadCount).toBe(2);
    expect(fresh.chats[id]?.unreadCount).toBe(3);
    expect(
      applyIncomingMessage(fresh, incoming({ chatId: id, serverId: 'new' }), 'duplicate', 103_000),
    ).toBe(fresh);
  });

  it('counts a notification received while GetChats was in flight', () => {
    const id = '77011234567@c.us';
    const fromApi = mergeChats(
      emptyData(),
      [{ id, name: 'Анна', unreadCount: 2 }],
      120_000,
      100_000,
    );
    const updated = applyIncomingMessage(
      fromApi,
      incoming({ chatId: id, at: 110_000 }),
      'during-refresh',
      121_000,
    );

    expect(updated.chats[id]?.unreadCount).toBe(3);
  });

  it('counts a notification received while ReadChat was in flight', () => {
    const id = '77011234567@c.us';
    const fromApi = mergeChats(emptyData(), [{ id, name: 'Анна', unreadCount: 2 }], 100_000);
    const read = markMessagesRead(fromApi, id, 2, 120_000, 100_000);
    const updated = applyIncomingMessage(
      read,
      incoming({ chatId: id, at: 110_000 }),
      'during-read',
      121_000,
    );

    expect(updated.chats[id]?.unreadCount).toBe(1);
  });

  it('keeps messages received while a read request is in flight', () => {
    const id = '77011234567@c.us';
    const fromApi = mergeChats(emptyData(), [{ id, name: 'Анна', unreadCount: 2 }], 100_000);
    const fresh = applyIncomingMessage(
      fromApi,
      incoming({ chatId: id, at: 101_000 }),
      'fresh',
      101_000,
    );

    expect(markMessagesRead(fresh, id, 2, 102_000).chats[id]?.unreadCount).toBe(1);
    expect(
      mergeChats(
        markMessagesRead(fresh, id, 2, 102_000),
        [{ id, name: 'Анна', unreadCount: 2 }],
        110_000,
      ).chats[id]?.unreadCount,
    ).toBe(1);
  });
  it('deduplicates by chat and server ID, without changing order', () => {
    const first = applyMessage(emptyData(), incoming(), 'local-1');
    const repeated = applyMessage(first, incoming(), 'local-2');

    expect(repeated).toBe(first);
    expect(Object.keys(first.messages)).toEqual(['local-1']);
    expect(first.messages['local-1']?.serverId).toBe('9007199254740993001');

    const anotherChat = applyMessage(first, incoming({ chatId: '456' }), 'local-3');

    expect(Object.keys(anotherChat.messages)).toHaveLength(2);
  });

  it('keeps a phone webhook in the chat created with a WhatsApp lid', () => {
    const lid = '120650379300963@lid';
    const data = {
      ...emptyData(),
      chats: {
        [lid]: { id: lid, name: 'Анна', phone: '77011234567', activityAt: 0 },
      },
    };
    const event = incoming({ chatId: '77011234567@c.us', phone: '77011234567' });

    const first = applyMessage(data, event, 'local-1');
    const duplicate = applyMessage(first, event, 'local-2');

    expect(Object.keys(first.chats)).toEqual([lid]);
    expect(first.messages['local-1']?.chatId).toBe(lid);
    expect(duplicate).toBe(first);
  });

  it('merges an API echo with its local send', () => {
    let data = beginSend(chat(), { localId: 'local', chatId: '123', text: 'Текст', now: 2000 });
    data = applyMessage(
      data,
      incoming({ serverId: '99', direction: 'outgoing', text: 'Текст' }),
      'echo',
    );
    data = acceptSend(data, 'local', '99');

    expect(Object.keys(data.messages)).toEqual(['local']);
    expect(data.messages.local).toMatchObject({
      localId: 'local',
      request: 'accepted',
      createdAt: 2000,
    });
    expect(data.chats['123']?.lastMessageId).toBe('local');
  });

  it('clears only the version of the draft that was submitted', () => {
    const data = { ...chat(), drafts: { '123': { text: 'B', version: 2 } } };
    const result = beginSend(data, {
      localId: 'local',
      chatId: '123',
      text: 'A',
      draftVersion: 1,
      now: 1000,
    });

    expect(result.drafts['123']).toEqual({ text: 'B', version: 2 });
    expect(data.messages).toEqual({});
    expect(acceptSend(result, 'local', '99').drafts['123']?.text).toBe('B');
  });

  it('clears a matching draft once and preserves significant whitespace', () => {
    const text = '  первая строка\nвторая  ';
    const data = { ...chat(), drafts: { '123': { text, version: 1 } } };
    const result = beginSend(data, {
      localId: 'local',
      chatId: '123',
      text,
      draftVersion: 1,
      now: 1000,
    });

    expect(result.messages.local?.text).toBe(text);
    expect(result.drafts['123']).toEqual({ text: '', version: 2 });
  });

  it('uses stable insertion order when timestamps match', () => {
    let data = applyMessage(chat(), incoming({ serverId: '2' }), 'first');
    data = applyMessage(data, incoming({ serverId: '1' }), 'second');

    expect(sortedMessages(data.messages, '123').map((m) => m.localId)).toEqual(['first', 'second']);
  });

  it('keeps the latest chat preview when an older message arrives later', () => {
    let data = applyMessage(chat(), incoming({ serverId: 'newer', at: 3000 }), 'newer');
    data = applyMessage(data, incoming({ serverId: 'older', at: 1000 }), 'older');

    expect(data.chats['123']?.lastMessageId).toBe('newer');
    expect(data.chats['123']?.activityAt).toBe(3000);
  });

  it('orders API second-resolution timestamps with a local millisecond send', () => {
    let data = applyMessage(chat(), incoming({ serverId: 'first', at: 1000 }), 'first');
    data = beginSend(data, { localId: 'local', chatId: '123', text: 'Ответ', now: 1500 });
    data = applyMessage(data, incoming({ serverId: 'last', at: 1000 }), 'last');

    expect(sortedMessages(data.messages, '123').map((message) => message.localId)).toEqual([
      'first',
      'local',
      'last',
    ]);
  });
});

describe('user input', () => {
  it('normalizes international phone formatting without coercing IDs', () => {
    expect(normalizePhone('+7 (701) 123-45-67')).toBe('77011234567');
    expect(() => normalizePhone('abc')).toThrow();
    expect(() => normalizePhone('01234567')).toThrow();
  });
  it('validates the WhatsApp text limit, including emoji', () => {
    expect(validateText(' \n\t')).toBeTruthy();
    expect(validateText('a'.repeat(MAX_MESSAGE_LENGTH))).toBeNull();
    expect(validateText('a'.repeat(MAX_MESSAGE_LENGTH + 1))).toBeTruthy();
    expect(validateText('😀'.repeat(MAX_MESSAGE_LENGTH / 2))).toBeNull();
    expect(validateText('😀'.repeat(MAX_MESSAGE_LENGTH / 2) + 'a')).toBeTruthy();
  });
});
