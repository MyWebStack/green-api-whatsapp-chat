import { createStore } from 'zustand/vanilla';
import {
  acceptSend,
  applyIncomingMessage,
  applyMessage,
  beginSend,
  canDeleteFromWhatsApp,
  canDeleteForEveryone,
  emptyData,
  failSend,
  mergeChats,
  markMessageDeleted,
  markMessagesRead,
  normalizePhone,
  validateText,
  type ChatData,
  type Draft,
} from '../domain/model';
import { AppError, asAppError, canRetry } from './errors';
import {
  type ConnectionConfig,
  type MessagingGateway,
  type RuntimeDependencies,
  type SavedSession,
  type TabEvent,
} from './ports';

function instanceKeyOf(config: ConnectionConfig): string {
  return `${config.apiUrl}|${config.idInstance}`;
}

export interface ViewState {
  phase: 'signedOut' | 'connecting' | 'active' | 'reconnecting' | 'attention' | 'closing';
  data: ChatData;
  drafts: Record<string, Draft>;
  accountId: string;
  instanceId: string;
  notice: string;
  storageWarning: boolean;
  online: boolean;
  busyChats: Record<string, boolean>;
  blockedNotificationId: number | null;
  accountAvatar: string;
  chatListStatus: 'idle' | 'loading' | 'ready' | 'error';
  historyStatus: Record<string, 'loading' | 'ready' | 'error'>;
}

interface SessionContext {
  config: ConnectionConfig;
  gateway: MessagingGateway;
  abort: AbortController;
  receiver: AbortController;
  instanceKey: string;
  accountId: string;
  release?: () => void;
  unsubscribe?: () => void;
  wake?: AbortController;
  blockedNotificationId?: number;
  avatarRequested?: boolean;
  avatarLookups: Set<string>;
  readingChats: Set<string>;
  readAgain: Set<string>;
  recentChatsRequested?: boolean;
}

const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;

const initialView = (saved?: SavedSession | null): ViewState => ({
  phase: saved ? 'connecting' : 'signedOut',
  data: emptyData(),
  drafts: {},
  accountId: saved?.accountId ?? '',
  instanceId: saved?.config.idInstance ?? '',
  notice: '',
  storageWarning: false,
  online: true,
  busyChats: {},
  blockedNotificationId: null,
  accountAvatar: '',
  chatListStatus: saved ? 'loading' : 'idle',
  historyStatus: {},
});

export function canSend(state: ViewState): boolean {
  return state.phase === 'active' && state.online;
}

/** Coordinates the API and in-memory chat state. */
export class ChatRuntime {
  readonly store;
  private context?: SessionContext;
  private mountGeneration = 0;
  private connectionRequest = 0;
  private historyRequests: Promise<void> = Promise.resolve();
  private lastHistoryRequestAt = 0;
  private avatarRequests: Promise<void> = Promise.resolve();
  private lastAvatarRequestAt = 0;
  private readRequests: Promise<void> = Promise.resolve();
  private lastReadRequestAt = 0;

  constructor(private readonly deps: RuntimeDependencies) {
    this.store = createStore<ViewState>()(() => initialView(deps.sessions.read()));
  }

  private isCurrent(ctx: SessionContext) {
    return this.context === ctx && !ctx.abort.signal.aborted;
  }

  private assertCurrent(ctx: SessionContext) {
    if (!this.isCurrent(ctx)) throw new AppError('cancelled', 'Сессия завершена.');
  }

  private publish(patch: Partial<ViewState>) {
    this.store.setState(patch);
  }

  private async commit(ctx: SessionContext, reduce: (data: ChatData) => ChatData): Promise<void> {
    this.assertCurrent(ctx);
    const state = this.store.getState();
    const previous = state.data;
    const data = reduce({ ...previous, drafts: state.drafts });
    this.publish({ data, drafts: data.drafts });

    const chats = Object.fromEntries(
      Object.entries(data.chats).filter(([id, chat]) => chat !== previous.chats[id]),
    );
    const messages = Object.fromEntries(
      Object.entries(data.messages).filter(([id, message]) => message !== previous.messages[id]),
    );
    if (Object.keys(chats).length || Object.keys(messages).length) {
      this.deps.tabs.announce({
        type: 'updated',
        instanceKey: ctx.instanceKey,
        accountId: ctx.accountId,
        chats,
        messages,
      });
    }
  }

  mount() {
    const generation = ++this.mountGeneration;
    const saved = this.deps.sessions.read();
    if (saved && !this.context) this.publish(initialView(saved));

    queueMicrotask(() => {
      if (generation !== this.mountGeneration) return;
      if (saved) void this.connect(saved.config, saved);
    });

    return () => {
      ++this.mountGeneration;
      ++this.connectionRequest;
      if (!this.context?.accountId) this.publish(initialView());
      void this.stop();
    };
  }

  private handleRemoteLogout(instanceKey: string) {
    const stored = this.deps.sessions.read();
    const activeKey = this.context?.instanceKey || (stored && instanceKeyOf(stored.config));
    if (activeKey !== instanceKey) return;

    const request = ++this.connectionRequest;
    this.deps.sessions.clear();
    void this.stop().then(() => {
      if (request !== this.connectionRequest || this.context) return;
      this.publish({
        ...initialView(),
        notice: 'Сессия завершена в другой вкладке. Подключитесь заново.',
      });
    });
  }

  private async stop() {
    const ctx = this.context;
    if (!ctx) return;
    ctx.abort.abort();
    ctx.unsubscribe?.();
    ctx.release?.();
    this.context = undefined;
  }

  async connect(config: ConnectionConfig, saved?: SavedSession): Promise<void> {
    const request = ++this.connectionRequest;
    await this.stop();
    if (request !== this.connectionRequest) return;
    let gateway: MessagingGateway;
    try {
      gateway = this.deps.gateway(config);
    } catch (error) {
      this.publish({ ...initialView(), notice: asAppError(error).message });
      return;
    }
    const ctx: SessionContext = {
      config,
      gateway,
      abort: new AbortController(),
      receiver: new AbortController(),
      instanceKey: instanceKeyOf(config),
      accountId: '',
      avatarLookups: new Set(),
      readingChats: new Set(),
      readAgain: new Set(),
    };
    this.context = ctx;
    this.publish({
      ...initialView(saved),
      phase: 'connecting',
      instanceId: config.idInstance,
      online: this.deps.online(),
    });
    try {
      const release = await this.deps.tabs.acquire(ctx.instanceKey);
      if (!this.isCurrent(ctx)) {
        release?.();
        return;
      }
      ctx.release = release ?? undefined;
      ctx.unsubscribe = this.deps.tabs.subscribe((event) => {
        if (event.type === 'logout') this.handleRemoteLogout(event.instanceKey);
        else this.syncAccount(ctx, event);
      });
      // Each tab connects; only the lock holder reads the notification queue.
      void this.run(ctx);
    } catch (error) {
      this.handleFailure(ctx, asAppError(error));
    }
  }

  private loadAccount(ctx: SessionContext, accountId: string) {
    this.assertCurrent(ctx);
    ctx.accountId = accountId;
    ctx.avatarRequested = false;
    ctx.avatarLookups.clear();
    ctx.readingChats.clear();
    ctx.readAgain.clear();
    ctx.recentChatsRequested = false;
    const data = emptyData();
    const chatId = this.deps.lastChat.read(`${ctx.instanceKey}|${accountId}`);
    if (chatId) {
      const phone = chatId.endsWith('@c.us') ? chatId.slice(0, -5) : undefined;
      data.chats[chatId] = { id: chatId, name: phone ? `+${phone}` : chatId, phone, activityAt: 0 };
      data.selectedChatId = chatId;
    }
    this.publish({
      data,
      drafts: {},
      accountId,
      accountAvatar: '',
      chatListStatus: 'idle',
      historyStatus: {},
    });
  }

  private syncAccount(ctx: SessionContext, event: Extract<TabEvent, { type: 'updated' }>) {
    if (
      !this.isCurrent(ctx) ||
      event.instanceKey !== ctx.instanceKey ||
      event.accountId !== ctx.accountId
    )
      return;
    const current = this.store.getState().data;
    const messages = { ...current.messages };
    const localIds = new Map<string, string>();
    for (const incoming of Object.values(event.messages)) {
      const existing =
        messages[incoming.localId] ??
        (incoming.serverId
          ? Object.values(messages).find(
              (message) =>
                message.chatId === incoming.chatId && message.serverId === incoming.serverId,
            )
          : undefined);
      const localId = existing?.localId ?? incoming.localId;
      localIds.set(incoming.localId, localId);
      messages[localId] = existing?.deleted ? existing : { ...incoming, localId };
      if (incoming.serverId) {
        for (const message of Object.values(messages)) {
          if (
            message.localId !== localId &&
            message.chatId === incoming.chatId &&
            message.serverId === incoming.serverId
          ) {
            delete messages[message.localId];
            localIds.set(message.localId, localId);
          }
        }
      }
    }
    const chats = { ...current.chats, ...event.chats };
    for (const [id, incoming] of Object.entries(event.chats)) {
      const local = current.chats[id];
      if (
        local?.readAt &&
        (incoming.readAt ?? 0) < local.readAt &&
        (incoming.unreadUpdatedAt ?? incoming.unreadSnapshotAt ?? 0) <= local.readAt
      ) {
        chats[id] = {
          ...incoming,
          unreadCount: local.unreadCount,
          unreadUpdatedAt: local.unreadUpdatedAt,
          unreadSnapshotAt: local.unreadSnapshotAt,
          readAt: local.readAt,
        };
      }
    }
    for (const [id, chat] of Object.entries(chats)) {
      const lastMessageId = chat.lastMessageId && localIds.get(chat.lastMessageId);
      if (lastMessageId) chats[id] = { ...chat, lastMessageId };
    }
    this.publish({
      data: {
        ...current,
        chats,
        messages,
        sequence: Math.max(
          current.sequence,
          ...Object.values(event.messages).map((message) => message.sequence),
        ),
      },
    });
    const selected = current.selectedChatId;
    if (
      selected &&
      Object.values(event.messages).some(
        (message) => message.chatId === selected && message.direction === 'incoming',
      )
    ) {
      this.markChatRead(selected, true);
    } else if (selected && event.chats[selected]?.unreadCount) {
      this.markChatRead(selected);
    }
  }

  private async establish(ctx: SessionContext) {
    const signal = AbortSignal.any([ctx.abort.signal, ctx.receiver.signal]);
    const instanceState = await ctx.gateway.getState(signal);
    this.assertCurrent(ctx);
    if (instanceState !== 'authorized') throw this.instanceStateError(instanceState);
    const settings = await ctx.gateway.getSettings(signal);
    this.assertCurrent(ctx);
    if (settings.typeInstance && settings.typeInstance !== 'whatsapp') {
      throw new AppError('configuration', 'Нужен WhatsApp-инстанс GREEN-API.');
    }
    if (settings.webhookUrl) {
      throw new AppError(
        'configuration',
        'Очистите Webhook URL в кабинете, подождите минуту и повторите подключение.',
      );
    }
    if (settings.incomingWebhook !== 'yes') {
      throw new AppError(
        'configuration',
        'В настройках инстанса включите «Получать уведомления о входящих сообщениях и файлах», сохраните изменения и повторите подключение.',
      );
    }
    if (settings.wid !== ctx.accountId) this.loadAccount(ctx, settings.wid);
    this.assertCurrent(ctx);
    const sessionSaved = this.deps.sessions.write({
      config: ctx.config,
      accountId: ctx.accountId,
    });
    this.publish({
      phase: 'active',
      notice: '',
      storageWarning: !sessionSaved,
      online: this.deps.online(),
    });
    if (!ctx.avatarRequested) {
      ctx.avatarRequested = true;
      void this.loadAccountAvatar(ctx);
    }
    if (!ctx.recentChatsRequested) {
      ctx.recentChatsRequested = true;
      void this.refreshChats();
    }
  }

  private async loadAccountAvatar(ctx: SessionContext) {
    const accountId = ctx.accountId;
    try {
      const avatar = await ctx.gateway.getAccountAvatar(ctx.abort.signal);
      if (this.isCurrent(ctx) && ctx.accountId === accountId)
        this.publish({ accountAvatar: avatar });
    } catch {
      // A missing profile picture must not interrupt message delivery.
    }
  }

  loadChatAvatar(chatId: string) {
    const ctx = this.context;
    const state = this.store.getState();
    const chat = state.data.chats[chatId];
    if (!ctx || !this.isCurrent(ctx) || !canSend(state) || !chat) return;
    if (chat.avatarCheckedAt && this.deps.now() - chat.avatarCheckedAt < AVATAR_CACHE_MS) return;
    if (ctx.avatarLookups.has(chatId)) return;
    ctx.avatarLookups.add(chatId);

    this.avatarRequests = this.avatarRequests.then(async () => {
      try {
        this.assertCurrent(ctx);
        const delay = Math.max(0, 150 - (this.deps.now() - this.lastAvatarRequestAt));
        if (delay) await this.deps.wait(delay, ctx.abort.signal);
        this.assertCurrent(ctx);
        this.lastAvatarRequestAt = this.deps.now();
        const avatarUrl = await ctx.gateway.getChatAvatar(chatId, ctx.abort.signal);
        await this.commit(ctx, (data) => {
          const current = data.chats[chatId];
          if (!current) return data;
          return {
            ...data,
            chats: {
              ...data.chats,
              [chatId]: { ...current, avatarUrl, avatarCheckedAt: this.deps.now() },
            },
          };
        });
      } catch {
        // Photos are optional; a failed lookup should not interrupt the chat.
      } finally {
        ctx.avatarLookups.delete(chatId);
      }
    });
  }

  markChatRead(chatId: string, force = false) {
    const ctx = this.context;
    const state = this.store.getState();
    if (!ctx || !this.isCurrent(ctx) || !this.deps.visible()) return;
    if (state.data.selectedChatId !== chatId || !state.data.chats[chatId]) return;
    const count = state.data.chats[chatId].unreadCount ?? 0;
    if (!count && !force) return;

    const now = this.deps.now();
    void this.commit(ctx, (data) => markMessagesRead(data, chatId, count, now));
    if (!canSend(state)) return;
    if (ctx.readingChats.has(chatId)) {
      ctx.readAgain.add(chatId);
      return;
    }
    ctx.readingChats.add(chatId);

    this.readRequests = this.readRequests.then(async () => {
      try {
        this.assertCurrent(ctx);
        const delay = Math.max(0, 1100 - (this.deps.now() - this.lastReadRequestAt));
        if (delay) await this.deps.wait(delay, ctx.abort.signal);
        this.assertCurrent(ctx);
        this.lastReadRequestAt = this.deps.now();
        await ctx.gateway.markChatRead(chatId, ctx.abort.signal);
      } catch (error) {
        // ReadChat only syncs the local read mark with WhatsApp.
        const issue = asAppError(error);
        if (this.isCurrent(ctx) && issue.kind === 'auth') this.handleFailure(ctx, issue);
      } finally {
        ctx.readingChats.delete(chatId);
        if (ctx.readAgain.delete(chatId) && this.isCurrent(ctx)) this.markChatRead(chatId, true);
      }
    });
  }

  async refreshChats() {
    const ctx = this.context;
    if (!ctx || !this.isCurrent(ctx) || this.store.getState().chatListStatus === 'loading') return;
    this.publish({ chatListStatus: 'loading' });
    try {
      const requestedAt = this.deps.now();
      const chats = await ctx.gateway.getChats(ctx.abort.signal);
      this.assertCurrent(ctx);
      await this.commit(ctx, (data) => mergeChats(data, chats, this.deps.now(), requestedAt));
      this.publish({ chatListStatus: 'ready' });
      const selectedChatId = this.store.getState().data.selectedChatId;
      if (selectedChatId) this.markChatRead(selectedChatId);
    } catch {
      if (this.isCurrent(ctx)) this.publish({ chatListStatus: 'error' });
    }
  }

  async loadChatHistory(chatId: string) {
    const ctx = this.context;
    const state = this.store.getState();
    if (!ctx || !this.isCurrent(ctx) || !state.data.chats[chatId]) return;
    if (state.historyStatus[chatId] === 'loading' || state.historyStatus[chatId] === 'ready')
      return;
    const accountId = ctx.accountId;
    this.publish({ historyStatus: { ...state.historyStatus, [chatId]: 'loading' } });

    const request = this.historyRequests.then(async () => {
      try {
        this.assertCurrent(ctx);
        const delay = Math.max(0, 1100 - (this.deps.now() - this.lastHistoryRequestAt));
        if (delay) await this.deps.wait(delay, ctx.abort.signal);
        this.assertCurrent(ctx);
        this.lastHistoryRequestAt = this.deps.now();
        const messages = await ctx.gateway.getChatHistory(chatId, 100, ctx.abort.signal);
        this.assertCurrent(ctx);
        if (ctx.accountId !== accountId) return;
        await this.commit(ctx, (data) =>
          messages.reduce(
            (current, message) => applyMessage(current, message, this.deps.id()),
            data,
          ),
        );
        if (ctx.accountId === accountId) {
          this.publish({
            historyStatus: { ...this.store.getState().historyStatus, [chatId]: 'ready' },
          });
        }
      } catch {
        if (this.isCurrent(ctx) && ctx.accountId === accountId) {
          this.publish({
            historyStatus: { ...this.store.getState().historyStatus, [chatId]: 'error' },
          });
        }
      }
    });
    this.historyRequests = request;
    await request;
  }

  private instanceStateError(state: string): AppError {
    if (state === 'starting') {
      return new AppError('temporary', 'Инстанс запускается. Восстанавливаем соединение…');
    }
    if (state === 'notAuthorized' || state === 'pendingPassword') {
      return new AppError('configuration', 'Завершите авторизацию WhatsApp в кабинете GREEN-API.');
    }
    return new AppError(
      'configuration',
      'Инстанс недоступен или ограничен. Проверьте его состояние в кабинете GREEN-API.',
    );
  }

  private async run(ctx: SessionContext) {
    const signal = AbortSignal.any([ctx.abort.signal, ctx.receiver.signal]);
    let retryCount = 0;
    let pendingReceiptId: number | undefined;
    let acknowledgementFailures = 0;

    while (this.isCurrent(ctx) && !signal.aborted) {
      try {
        if (!this.deps.online()) {
          throw new AppError('temporary', 'Нет соединения. Ожидаем восстановления связи.');
        }
        await this.establish(ctx);

        while (this.isCurrent(ctx) && !signal.aborted) {
          if (!this.deps.online()) {
            throw new AppError('temporary', 'Нет соединения. Ожидаем восстановления связи.');
          }

          if (!ctx.release) {
            const release = await this.deps.tabs.acquire(ctx.instanceKey);
            if (!this.isCurrent(ctx) || signal.aborted) {
              release?.();
              return;
            }
            ctx.release = release ?? undefined;
            if (!ctx.release) {
              await this.deps.wait(2000, signal);
              continue;
            }
          }

          const requestStartedAt = this.deps.now();
          const envelope = await ctx.gateway.receive(signal);
          this.assertCurrent(ctx);
          if (!envelope) {
            retryCount = 0;
            const elapsed = this.deps.now() - requestStartedAt;
            await this.deps.wait(Math.max(0, 2000 - elapsed), signal);
            continue;
          }

          const { event, receiptId } = envelope;
          if (receiptId !== pendingReceiptId) {
            pendingReceiptId = receiptId;
            acknowledgementFailures = 0;
          }

          if (event.kind === 'invalid') {
            ctx.blockedNotificationId = receiptId;
            this.publish({ blockedNotificationId: receiptId });
            throw new AppError(
              'protocol',
              `Уведомление ${receiptId} содержит некорректные данные. Оно осталось в очереди.`,
            );
          }

          if (event.kind === 'message') {
            await this.commit(ctx, (data) =>
              applyIncomingMessage(data, event, this.deps.id(), this.deps.now()),
            );
          }

          const acknowledged = await ctx.gateway.acknowledge(receiptId, signal);
          this.assertCurrent(ctx);
          if (!acknowledged && ++acknowledgementFailures >= 3) {
            throw new AppError(
              'protocol',
              'Не удалось подтвердить уведомление. Проверьте, что другой клиент не использует очередь этого инстанса.',
            );
          }
          if (acknowledged) {
            acknowledgementFailures = 0;
            pendingReceiptId = undefined;
            if (event.kind === 'message' && event.direction === 'incoming') {
              const data = this.store.getState().data;
              const selected = data.selectedChatId && data.chats[data.selectedChatId];
              if (
                selected &&
                (selected.id === event.chatId || (event.phone && selected.phone === event.phone))
              ) {
                this.markChatRead(selected.id, true);
              }
            }
          }

          retryCount = 0;
          if (event.kind === 'state' && event.state !== 'authorized') {
            throw this.instanceStateError(event.state);
          }
          if (event.kind === 'limit') {
            throw new AppError(
              'configuration',
              'Достигнуто ограничение тарифа. Проверьте инстанс в кабинете GREEN-API.',
            );
          }
          if (!acknowledged) await this.deps.wait(1000, signal);
        }
      } catch (error) {
        if (!this.isCurrent(ctx) || signal.aborted) return;
        const issue = asAppError(error);
        if (!canRetry(issue)) {
          this.handleFailure(ctx, issue);
          return;
        }
        this.publish({
          phase: ctx.accountId ? 'reconnecting' : 'connecting',
          notice: issue.message,
          online: this.deps.online(),
        });
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(retryCount++, 5));
        const retryDelay = Math.max(
          issue.retryAfterMs ?? 0,
          backoff * (0.85 + this.deps.random() * 0.3),
        );
        ctx.wake = new AbortController();
        try {
          await this.deps.wait(retryDelay, AbortSignal.any([signal, ctx.wake.signal]));
        } catch {
          if (!this.isCurrent(ctx) || signal.aborted) return;
        }
      }
    }
  }

  private handleFailure(ctx: SessionContext, error: AppError) {
    if (!this.isCurrent(ctx) || error.kind === 'cancelled') return;
    if (error.kind === 'auth') {
      ++this.connectionRequest;
      this.deps.sessions.clear();
      void this.stop().then(() => {
        if (!this.context) this.publish({ ...initialView(), notice: error.message });
      });
      return;
    }

    ctx.receiver.abort();
    this.publish({
      phase: 'attention',
      notice: error.message,
    });
  }

  connectivityChanged() {
    this.publish({ online: this.deps.online() });
    this.context?.wake?.abort();
  }

  dismissNotice() {
    if (this.store.getState().phase === 'active') this.publish({ notice: '' });
  }

  resume() {
    this.connectivityChanged();
    const selected = this.store.getState().data.selectedChatId;
    if (selected) this.markChatRead(selected, true);
  }

  async retry() {
    const ctx = this.context;
    if (!ctx) return;
    if (this.store.getState().phase === 'attention') {
      ctx.receiver = new AbortController();
      void this.run(ctx);
    } else {
      this.connectivityChanged();
    }
  }

  async skipInvalidNotification(): Promise<void> {
    const ctx = this.context;
    const receiptId = ctx?.blockedNotificationId;
    if (!ctx || receiptId === undefined || this.store.getState().phase !== 'attention') return;

    try {
      const acknowledged = await ctx.gateway.acknowledge(receiptId, ctx.abort.signal);
      this.assertCurrent(ctx);
      if (!acknowledged) {
        throw new AppError('protocol', 'Не удалось пропустить уведомление. Повторите попытку.');
      }
      ctx.blockedNotificationId = undefined;
      this.publish({ blockedNotificationId: null });
      await this.retry();
    } catch (error) {
      if (this.isCurrent(ctx)) this.publish({ notice: asAppError(error).message });
    }
  }

  private requireReady(): SessionContext {
    const ctx = this.context;
    const state = this.store.getState();
    if (!ctx || !this.isCurrent(ctx) || !canSend(state) || !this.deps.online()) {
      throw new AppError(
        'temporary',
        'Дождитесь восстановления соединения. Текст остаётся в поле ввода.',
      );
    }
    return ctx;
  }

  async createChat(input: string, cancellationSignal?: AbortSignal): Promise<string> {
    const ctx = this.requireReady();
    const phone = normalizePhone(input);
    if (cancellationSignal?.aborted) {
      throw new AppError('cancelled', 'Проверка номера отменена.');
    }
    const existing = Object.values(this.store.getState().data.chats).find(
      (chat) => chat.phone === phone,
    );
    const signal = cancellationSignal
      ? AbortSignal.any([ctx.abort.signal, cancellationSignal])
      : ctx.abort.signal;
    let recipient;
    try {
      recipient = existing
        ? { chatId: existing.id, name: existing.name }
        : await ctx.gateway.resolvePhone(phone, signal);
    } catch (error) {
      const issue = asAppError(error);
      if (issue.kind === 'auth') this.handleFailure(ctx, issue);
      throw error;
    }
    this.assertCurrent(ctx);
    if (signal.aborted) throw new AppError('cancelled', 'Проверка номера отменена.');
    try {
      await this.commit(ctx, (data) => {
        if (signal.aborted) throw new AppError('cancelled', 'Проверка номера отменена.');
        const knownChat = data.chats[recipient.chatId];
        return {
          ...data,
          chats: {
            ...data.chats,
            [recipient.chatId]: knownChat
              ? { ...knownChat, phone }
              : {
                  id: recipient.chatId,
                  name: recipient.name,
                  phone,
                  activityAt: this.deps.now(),
                },
          },
          selectedChatId: recipient.chatId,
        };
      });
    } catch (error) {
      this.handleFailure(ctx, asAppError(error));
      throw error;
    }
    this.deps.lastChat.write(`${ctx.instanceKey}|${ctx.accountId}`, recipient.chatId);
    return recipient.chatId;
  }

  selectChat(chatId: string | null) {
    const ctx = this.context;
    if (!ctx?.accountId || !this.isCurrent(ctx)) return;
    const current = this.store.getState().data;
    if (current.selectedChatId !== chatId)
      this.publish({ data: { ...current, selectedChatId: chatId } });
    if (chatId) {
      this.deps.lastChat.write(`${ctx.instanceKey}|${ctx.accountId}`, chatId);
      this.markChatRead(chatId);
    }
  }

  setDraft(chatId: string, text: string) {
    const state = this.store.getState();
    this.publish({
      drafts: {
        ...state.drafts,
        [chatId]: { text, version: (state.drafts[chatId]?.version ?? 0) + 1 },
      },
    });
  }

  async send(chatId: string, retryText?: string): Promise<void> {
    const ctx = this.requireReady();
    const state = this.store.getState();
    if (state.busyChats[chatId]) return;
    const draft = state.drafts[chatId];
    const text = retryText ?? draft?.text ?? '';
    const validation = validateText(text);
    if (validation) throw new Error(validation);
    const localId = this.deps.id();
    this.publish({ busyChats: { ...state.busyChats, [chatId]: true } });
    try {
      await this.commit(ctx, (data) =>
        beginSend(data, {
          localId,
          chatId,
          text,
          draftVersion: retryText === undefined ? draft?.version : undefined,
          now: this.deps.now(),
        }),
      );
      this.assertCurrent(ctx);
      let response: { idMessage: string };
      try {
        response = await ctx.gateway.sendText(chatId, text, ctx.abort.signal);
      } catch (error) {
        this.assertCurrent(ctx);
        const issue = asAppError(error);
        const uncertain =
          issue.kind === 'temporary' || issue.kind === 'protocol' || issue.kind === 'cancelled';
        await this.commit(ctx, (data) =>
          failSend(data, localId, uncertain ? 'unknown' : 'rejected', issue.message),
        );
        if (issue.kind === 'auth') this.handleFailure(ctx, issue);
        return;
      }
      await this.commit(ctx, (data) => acceptSend(data, localId, response.idMessage));
    } catch (error) {
      const issue = asAppError(error);
      if (issue.kind !== 'cancelled') {
        this.handleFailure(ctx, issue);
        throw issue;
      }
    } finally {
      if (this.isCurrent(ctx))
        this.publish({ busyChats: { ...this.store.getState().busyChats, [chatId]: false } });
    }
  }

  async deleteMessage(localId: string, forEveryone: boolean): Promise<void> {
    const ctx = this.requireReady();
    const message = this.store.getState().data.messages[localId];
    if (!message || message.deleted) return;
    if (message.direction !== 'outgoing') {
      throw new AppError('configuration', 'Входящие сообщения нельзя удалить из приложения.');
    }
    if (message.request === 'sending') {
      throw new AppError('temporary', 'Дождитесь результата отправки сообщения.');
    }
    if (forEveryone && !canDeleteForEveryone(message, this.deps.now())) {
      throw new AppError('configuration', 'Это сообщение уже нельзя удалить у всех.');
    }

    if (canDeleteFromWhatsApp(message) && message.serverId) {
      await ctx.gateway.deleteMessage(
        message.chatId,
        message.serverId,
        !forEveryone,
        ctx.abort.signal,
      );
      this.assertCurrent(ctx);
    }
    await this.commit(ctx, (data) => markMessageDeleted(data, localId));
  }

  async logout(): Promise<void> {
    ++this.connectionRequest;
    const ctx = this.context;
    if (ctx) this.deps.tabs.announce({ type: 'logout', instanceKey: ctx.instanceKey });
    this.deps.sessions.clear();
    await this.stop();
    this.publish(initialView());
  }
}
