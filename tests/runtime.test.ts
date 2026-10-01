import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ChatRuntime } from '../src/chat/application/runtime';
import { AppError } from '../src/chat/application/errors';
import { GreenApiGateway } from '../src/chat/infrastructure/green-api';
import { abortableWait } from '../src/session/browser';
import type {
  SavedSession,
  SessionStoragePort,
  TabCoordinator,
  TabEvent,
} from '../src/chat/application/ports';
import { config, endpoint, notification, server, settings } from './fixtures';

const chatId = '77011234567@c.us';
const phone = '77011234567';

interface HarnessOptions {
  sessions?: MemorySession;
  tabs?: Tabs;
  onWait?: (ms: number) => void;
}

class MemorySession implements SessionStoragePort {
  value: SavedSession | null = null;

  read() {
    return this.value;
  }

  write(value: SavedSession) {
    this.value = structuredClone(value);
    return true;
  }

  clear() {
    this.value = null;
  }
}

class Tabs implements TabCoordinator {
  locks = new Set<string>();
  listeners = new Set<(event: TabEvent) => void>();

  async acquire(key: string) {
    if (this.locks.has(key)) {
      return null;
    }

    this.locks.add(key);
    return () => {
      this.locks.delete(key);
    };
  }

  announce(event: TabEvent) {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  subscribe(listener: (event: TabEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const cleanups: (() => Promise<void>)[] = [];

function harness(options: HarnessOptions = {}) {
  const sessions = options.sessions ?? new MemorySession();
  const tabs = options.tabs ?? new Tabs();
  const api = new GreenApiGateway(config);
  let online = true;
  let visible = true;

  const runtime = new ChatRuntime({
    gateway: () => api,
    sessions,
    lastChat: { read: () => null, write: () => undefined },
    tabs,
    online: () => online,
    visible: () => visible,
    now: Date.now,
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    wait: (ms, signal) => {
      options.onWait?.(ms);
      return abortableWait(Math.min(ms, 25), signal);
    },
  });

  cleanups.push(async () => {
    await runtime.logout();
  });

  return {
    runtime,
    sessions,
    tabs,
    api,
    setVisible(value: boolean) {
      visible = value;
      if (visible) runtime.resume();
    },
    setOnline(value: boolean) {
      online = value;
      runtime.connectivityChanged();
    },
  };
}

async function ready(runtime: ChatRuntime) {
  await runtime.connect(config);
  await waitFor(() => expect(runtime.store.getState().phase).toBe('active'));
}

function messages(runtime: ChatRuntime) {
  return Object.values(runtime.store.getState().data.messages);
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }

  server.resetHandlers();
});

afterAll(() => server.close());

describe('application scenarios over the HTTP adapter', () => {
  it('does not start connecting after logout cancels a pending attempt', async () => {
    const { runtime, tabs } = harness();

    const connecting = runtime.connect(config);
    await runtime.logout();
    await connecting;

    expect(runtime.store.getState().phase).toBe('signedOut');
    expect(tabs.locks.size).toBe(0);
  });

  it('releases the reader lock on unmount', async () => {
    const { runtime, tabs } = harness();
    const unmount = runtime.mount();
    await ready(runtime);
    await runtime.createChat(phone);
    runtime.setDraft(chatId, 'Последние символы');

    unmount();
    await waitFor(() => expect(tabs.locks.size).toBe(0));
  });

  it('cancels a connection when the app unmounts before acquiring the tab', async () => {
    const { runtime, tabs } = harness();
    let finishAcquire!: (release: (() => void) | null) => void;
    const acquire = vi
      .spyOn(tabs, 'acquire')
      .mockImplementationOnce(() => new Promise((resolve) => (finishAcquire = resolve)));
    const unmount = runtime.mount();
    const connecting = runtime.connect(config);
    await waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    unmount();
    const remount = runtime.mount();
    finishAcquire(() => undefined);
    await connecting;

    expect(runtime.store.getState().phase).toBe('signedOut');
    expect(tabs.locks.size).toBe(0);
    remount();
  });

  it('connects with only incoming notifications enabled', async () => {
    server.use(
      http.get(endpoint('getSettings'), () =>
        HttpResponse.json({
          ...settings,
          outgoingWebhook: 'no',
          outgoingAPIMessageWebhook: 'no',
          outgoingMessageWebhook: 'no',
          stateWebhook: 'no',
        }),
      ),
    );

    const { runtime } = harness();
    await ready(runtime);
    expect(runtime.store.getState().phase).toBe('active');
  });

  it('loads the authorized account photo without delaying message reception', async () => {
    const { runtime } = harness();

    await ready(runtime);
    await waitFor(() =>
      expect(runtime.store.getState().accountAvatar).toBe('https://pps.whatsapp.net/profile.jpg'),
    );
  });

  it('keeps the chat active when the account photo is unavailable', async () => {
    server.use(http.get(endpoint('getWaSettings'), () => HttpResponse.error()));
    const { runtime } = harness();

    await ready(runtime);
    expect(runtime.store.getState().phase).toBe('active');
    expect(runtime.store.getState().accountAvatar).toBe('');
  });

  it.each([false, 'network'])(
    'marks the open chat read locally even when ReadChat returns %s',
    async (result) => {
      let readCalls = 0;
      server.use(
        http.get(endpoint('getChats'), () =>
          HttpResponse.json([{ id: chatId, name: 'Анна', type: 'user', unreadCount: 2 }]),
        ),
        http.post(endpoint('readChat'), () => {
          readCalls++;
          return result === 'network'
            ? HttpResponse.error()
            : HttpResponse.json({ setRead: false });
        }),
      );
      const { runtime } = harness();
      await ready(runtime);
      await waitFor(() => expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(2));
      runtime.selectChat(chatId);
      expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(0);
      await waitFor(() => expect(readCalls).toBe(1));
      expect(runtime.store.getState().notice).toBe('');
    },
  );

  it('keeps unread counts in a hidden tab until the user returns', async () => {
    server.use(
      http.get(endpoint('getChats'), () =>
        HttpResponse.json([{ id: chatId, name: 'Анна', type: 'user', unreadCount: 2 }]),
      ),
    );
    const { runtime, api, setVisible } = harness();
    const read = vi.spyOn(api, 'markChatRead');
    await ready(runtime);
    await waitFor(() => expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(2));
    setVisible(false);
    runtime.selectChat(chatId);
    expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(2);
    expect(read).not.toHaveBeenCalled();
    setVisible(true);
    expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(0);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
  });

  it('shows recent WhatsApp chats after connecting without waiting for a new message', async () => {
    server.use(
      http.get(endpoint('getChats'), () =>
        HttpResponse.json([{ id: '77011234567@c.us', name: 'Айгуль', type: 'user' }]),
      ),
    );
    const { runtime } = harness();

    await ready(runtime);
    await waitFor(() => expect(runtime.store.getState().chatListStatus).toBe('ready'));
    expect(runtime.store.getState().data.chats['77011234567@c.us']).toMatchObject({
      name: 'Айгуль',
      imported: true,
    });
  });

  it('paces polling when an empty notification response arrives immediately', async () => {
    const delays: number[] = [];
    const { runtime } = harness({ onWait: (ms) => delays.push(ms) });

    await ready(runtime);
    await waitFor(() => expect(delays.some((ms) => ms > 1500)).toBe(true));
  });

  it('keeps the app active through repeated receive timeouts and then receives a message', async () => {
    let attempts = 0;
    let consumed = false;
    server.use(
      http.get(endpoint('receiveNotification'), () => {
        if (++attempts <= 3) return new HttpResponse('Timeout', { status: 504 });
        return HttpResponse.json(consumed ? null : notification());
      }),
      http.delete(endpoint('deleteNotification') + '/:receipt', () => {
        consumed = true;
        return HttpResponse.json({ result: true });
      }),
    );
    const { runtime } = harness();
    const phases: string[] = [];
    const unsubscribe = runtime.store.subscribe((state) => phases.push(state.phase));
    try {
      await ready(runtime);
      await waitFor(() => expect(messages(runtime)).toHaveLength(1));
      expect(attempts).toBeGreaterThan(3);
      expect(phases).not.toContain('reconnecting');
      expect(runtime.store.getState().notice).toBe('');
    } finally {
      unsubscribe();
    }
  });

  it('explains which instance setting blocks incoming messages', async () => {
    server.use(
      http.get(endpoint('getSettings'), () =>
        HttpResponse.json({ ...settings, incomingWebhook: 'no' }),
      ),
    );

    const { runtime } = harness();
    await runtime.connect(config);
    await waitFor(() => expect(runtime.store.getState().phase).toBe('attention'));
    expect(runtime.store.getState().notice).toContain('Получать уведомления о входящих сообщениях');
  });

  it('rejects an instance that identifies itself as another messenger', async () => {
    server.use(
      http.get(endpoint('getSettings'), () =>
        HttpResponse.json({ ...settings, typeInstance: 'v3' }),
      ),
    );

    const { runtime } = harness();
    await runtime.connect(config);
    await waitFor(() => expect(runtime.store.getState().phase).toBe('attention'));
    expect(runtime.store.getState().notice).toContain('WhatsApp-инстанс');
  });

  it('runs connect → resolve phone → send → receive and commit before ack', async () => {
    const { runtime } = harness();

    await ready(runtime);
    await runtime.createChat('+7 701 123-45-67');
    runtime.setDraft(chatId, 'Привет из приложения');
    await runtime.send(chatId);

    expect(messages(runtime)[0]).toMatchObject({
      text: 'Привет из приложения',
      request: 'accepted',
    });
    expect(runtime.store.getState().drafts[chatId]?.text).toBe('');

    let consumed = false;
    server.use(
      http.get(endpoint('receiveNotification'), () =>
        HttpResponse.json(consumed ? null : notification()),
      ),
      http.delete(`${endpoint('deleteNotification')}/*`, () => {
        const data = runtime.store.getState().data;
        const replyWasSaved = Object.values(data.messages).some(
          (message) => message.text === 'Ответ из WhatsApp',
        );

        expect(replyWasSaved).toBe(true);
        consumed = true;
        return HttpResponse.json({ result: true });
      }),
    );

    await waitFor(() => expect(consumed).toBe(true));
    expect(messages(runtime)).toHaveLength(2);
  });

  it('preserves draft B and recipient when send A resolves late', async () => {
    const { runtime, api } = harness();

    await ready(runtime);
    await runtime.createChat(phone);

    let complete!: (value: { idMessage: string }) => void;
    const send = vi.spyOn(api, 'sendText').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );

    runtime.setDraft(chatId, 'A');
    const pending = runtime.send(chatId);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());

    runtime.setDraft(chatId, 'B');
    await runtime.selectChat(null);
    complete({ idMessage: '11' });
    await pending;

    expect(runtime.store.getState().drafts[chatId]?.text).toBe('B');
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([chatId, 'A']);
  });

  it('does not resend an ambiguous request', async () => {
    const { runtime, api } = harness();

    await ready(runtime);
    await runtime.createChat(phone);

    const send = vi
      .spyOn(api, 'sendText')
      .mockRejectedValue(new AppError('temporary', 'Ответ потерян'));

    runtime.setDraft(chatId, 'A');
    await runtime.send(chatId);

    expect(send).toHaveBeenCalledOnce();
    expect(messages(runtime)[0]?.request).toBe('unknown');
  });

  it('deduplicates when an acknowledgement response is lost', async () => {
    const { runtime } = harness();
    let attempts = 0;

    server.use(
      http.get(endpoint('receiveNotification'), () =>
        HttpResponse.json(attempts >= 2 ? null : notification()),
      ),
      http.delete(`${endpoint('deleteNotification')}/*`, () =>
        ++attempts === 1 ? HttpResponse.error() : HttpResponse.json({ result: true }),
      ),
    );

    await ready(runtime);
    await waitFor(() => expect(attempts).toBe(2));

    expect(messages(runtime)).toHaveLength(1);
  });

  it('leaves a malformed notification in the queue until the user skips it', async () => {
    const { runtime, api } = harness();
    await ready(runtime);
    const malformed = notification();
    const queue: unknown[] = [
      { ...malformed, body: { ...malformed.body, timestamp: -1 } },
      { ...notification('next', 'Следующее сообщение'), receiptId: 2 },
    ];
    server.use(
      http.get(endpoint('receiveNotification'), () => HttpResponse.json(queue[0] ?? null)),
      http.delete(`${endpoint('deleteNotification')}/*`, () => {
        queue.shift();
        return HttpResponse.json({ result: true });
      }),
    );
    const acknowledge = vi.spyOn(api, 'acknowledge');

    await waitFor(() => expect(runtime.store.getState().phase).toBe('attention'));
    expect(runtime.store.getState().blockedNotificationId).toBe(1);
    expect(acknowledge).not.toHaveBeenCalled();

    await runtime.skipInvalidNotification();
    await waitFor(() => expect(messages(runtime)).toHaveLength(1));
    expect(messages(runtime)[0]?.text).toBe('Следующее сообщение');
    expect(runtime.store.getState().blockedNotificationId).toBeNull();
  });

  it('keeps data and credentials through a temporary connection failure', async () => {
    const { runtime, sessions, setOnline } = harness();

    await ready(runtime);
    await runtime.createChat(phone);
    runtime.setDraft(chatId, 'Не потерять');

    setOnline(false);
    await waitFor(() => expect(runtime.store.getState().phase).toBe('reconnecting'));

    expect(runtime.store.getState().drafts[chatId]?.text).toBe('Не потерять');
    expect(sessions.value?.config.apiTokenInstance).toBe(config.apiTokenInstance);

    setOnline(true);
    await waitFor(() => expect(runtime.store.getState().phase).toBe('active'));
  });

  it('invalid credentials clear the session and in-memory history', async () => {
    const { runtime, sessions } = harness();

    await ready(runtime);
    await runtime.createChat(phone);

    server.use(
      http.get(endpoint('receiveNotification'), () => new HttpResponse(null, { status: 401 })),
    );
    await waitFor(() => expect(runtime.store.getState().phase).toBe('signedOut'));

    expect(sessions.value).toBeNull();
    expect(messages(runtime)).toHaveLength(0);
  });

  it('does not retry unexpected errors as network failures', async () => {
    const { runtime, api } = harness();
    const receive = vi.spyOn(api, 'receive').mockRejectedValue(new TypeError('broken parser'));
    await runtime.connect(config);

    await waitFor(() => expect(runtime.store.getState().phase).toBe('attention'));
    expect(runtime.store.getState().notice).toContain('Неожиданная ошибка');
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('allows a second tab to work and clears both sessions on logout', async () => {
    const tabs = new Tabs();
    const first = harness({ tabs });
    const second = harness({ tabs });

    await ready(first.runtime);
    await first.runtime.createChat(phone);
    await ready(second.runtime);
    await second.runtime.createChat(phone);
    expect(second.runtime.store.getState().data.chats[chatId]).toBeDefined();
    expect(tabs.locks.size).toBe(1);

    await second.runtime.logout();
    await waitFor(() => expect(first.runtime.store.getState().phase).toBe('signedOut'));
    expect(first.runtime.store.getState().data.chats).toEqual({});
  });

  it('preserves concurrent messages and local navigation across tabs', async () => {
    const tabs = new Tabs();
    const first = harness({ tabs });
    const second = harness({ tabs });
    await ready(first.runtime);
    await first.runtime.createChat(phone);
    await ready(second.runtime);
    await second.runtime.createChat(phone);
    await second.runtime.selectChat(null);
    vi.spyOn(first.api, 'sendText').mockResolvedValue({ idMessage: 'first-send' });
    vi.spyOn(second.api, 'sendText').mockResolvedValue({ idMessage: 'second-send' });
    first.runtime.setDraft(chatId, 'Мой черновик');
    await Promise.all([
      first.runtime.send(chatId, 'От первой'),
      second.runtime.send(chatId, 'От второй'),
    ]);

    await waitFor(() => expect(messages(first.runtime)).toHaveLength(2));
    await waitFor(() => expect(messages(second.runtime)).toHaveLength(2));
    expect(first.runtime.store.getState().drafts[chatId]?.text).toBe('Мой черновик');
    expect(first.runtime.store.getState().data.selectedChatId).toBe(chatId);
    expect(second.runtime.store.getState().data.selectedChatId).toBeNull();
  });

  it('merges the same history from two tabs without duplicates or restoring deleted text', async () => {
    const tabs = new Tabs();
    const first = harness({ tabs });
    const second = harness({ tabs });
    await ready(first.runtime);
    await ready(second.runtime);
    await first.runtime.createChat(phone);
    await second.runtime.createChat(phone);
    const event = {
      kind: 'message' as const,
      serverId: 'history-shared',
      chatId,
      name: 'Анна',
      text: 'Из истории',
      direction: 'outgoing' as const,
      at: Date.now(),
    };
    vi.spyOn(first.api, 'getChatHistory').mockResolvedValue([event]);
    vi.spyOn(second.api, 'getChatHistory').mockResolvedValue([event]);
    await Promise.all([
      first.runtime.loadChatHistory(chatId),
      second.runtime.loadChatHistory(chatId),
    ]);
    expect(messages(first.runtime)).toHaveLength(1);
    expect(messages(second.runtime)).toHaveLength(1);
    vi.spyOn(first.api, 'deleteMessage').mockResolvedValue();
    await first.runtime.deleteMessage(messages(first.runtime)[0]!.localId, false);
    second.runtime.store.setState({ historyStatus: {} });
    await second.runtime.loadChatHistory(chatId);
    expect(messages(first.runtime)[0]?.deleted).toBe(true);
    expect(messages(second.runtime)[0]?.deleted).toBe(true);
    expect(messages(second.runtime)[0]?.text).toBe('');
  });

  it('does not restore an old unread count from another tab after reading a chat', async () => {
    const { runtime, tabs } = harness();
    server.use(
      http.get(endpoint('getChats'), () =>
        HttpResponse.json([{ id: chatId, name: 'Анна', type: 'user', unreadCount: 2 }]),
      ),
    );
    await ready(runtime);
    await waitFor(() => expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(2));
    const staleChat = structuredClone(runtime.store.getState().data.chats[chatId]!);
    runtime.selectChat(chatId);
    await waitFor(() => expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(0));
    tabs.announce({
      type: 'updated',
      instanceKey: `${config.apiUrl}|${config.idInstance}`,
      accountId: settings.wid,
      chats: { [chatId]: staleChat },
      messages: {},
    });
    expect(runtime.store.getState().data.chats[chatId]?.unreadCount).toBe(0);
  });

  it('lets a follower consume the queue after the reader unmounts', async () => {
    const tabs = new Tabs();
    const first = harness({ tabs });
    const second = harness({ tabs });
    const unmount = first.runtime.mount();
    await ready(first.runtime);
    await ready(second.runtime);
    const receive = vi.spyOn(second.api, 'receive');
    expect(receive).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(receive).toHaveBeenCalled());
    expect(second.runtime.store.getState().phase).toBe('active');
    expect(tabs.locks.size).toBe(1);
  });

  it('ignores the completion of a send after logout', async () => {
    const { runtime, api } = harness();

    await ready(runtime);
    await runtime.createChat(phone);

    let resolve!: (value: { idMessage: string }) => void;
    const send = vi.spyOn(api, 'sendText').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    runtime.setDraft(chatId, 'A');
    const pending = runtime.send(chatId);
    await waitFor(() => expect(send).toHaveBeenCalled());

    await runtime.logout();
    resolve({ idMessage: '11' });
    await pending;

    expect(runtime.store.getState().data.messages).toEqual({});
    expect(runtime.store.getState().phase).toBe('signedOut');
  });

  it('receives an unacknowledged notification after a new runtime starts', async () => {
    const tabs = new Tabs();
    const first = harness({ tabs });
    let allowAck = false;
    let consumed = false;

    server.use(
      http.get(endpoint('receiveNotification'), () =>
        HttpResponse.json(consumed ? null : notification()),
      ),
      http.delete(`${endpoint('deleteNotification')}/*`, () => {
        if (!allowAck) {
          return HttpResponse.error();
        }

        consumed = true;
        return HttpResponse.json({ result: true });
      }),
    );

    const unmount = first.runtime.mount();
    await first.runtime.connect(config);
    await waitFor(() => expect(messages(first.runtime)).toHaveLength(1));

    const saved = structuredClone(first.sessions.value!);
    unmount();
    await waitFor(() => expect(tabs.locks.size).toBe(0));

    allowAck = true;
    const second = harness({ tabs });
    await second.runtime.connect(saved.config);
    await waitFor(() => expect(second.runtime.store.getState().phase).toBe('active'));
    await waitFor(() => expect(messages(second.runtime)).toHaveLength(1));
  });
});
