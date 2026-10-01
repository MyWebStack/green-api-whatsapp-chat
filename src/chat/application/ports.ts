import type { Chat, Message, ChatEvent, ChatMessageEvent, RemoteChat } from '../domain/model';

export interface ConnectionConfig {
  apiUrl: string;
  idInstance: string;
  apiTokenInstance: string;
}

export interface InstanceSettings {
  wid: string;
  typeInstance?: string;
  webhookUrl: string;
  incomingWebhook: 'yes' | 'no';
}

export interface Recipient {
  chatId: string;
  name: string;
}

export interface NotificationEnvelope {
  receiptId: number;
  event: ChatEvent;
}

export interface MessagingGateway {
  getState(signal: AbortSignal): Promise<string>;

  getSettings(signal: AbortSignal): Promise<InstanceSettings>;

  getAccountAvatar(signal: AbortSignal): Promise<string>;

  getChatAvatar(chatId: string, signal: AbortSignal): Promise<string>;

  markChatRead(chatId: string, signal: AbortSignal): Promise<boolean>;

  getChats(signal: AbortSignal): Promise<RemoteChat[]>;

  getChatHistory(chatId: string, count: number, signal: AbortSignal): Promise<ChatMessageEvent[]>;

  resolvePhone(phone: string, signal: AbortSignal): Promise<Recipient>;

  sendText(chatId: string, text: string, signal: AbortSignal): Promise<{ idMessage: string }>;

  deleteMessage(
    chatId: string,
    idMessage: string,
    onlySenderDelete: boolean,
    signal: AbortSignal,
  ): Promise<void>;

  receive(signal: AbortSignal): Promise<NotificationEnvelope | null>;

  acknowledge(receiptId: number, signal: AbortSignal): Promise<boolean>;
}

export interface SavedSession {
  config: ConnectionConfig;
  accountId: string;
}

export interface SessionStoragePort {
  read(): SavedSession | null;

  write(session: SavedSession): boolean;

  clear(): void;
}

export type TabEvent =
  | { type: 'logout'; instanceKey: string }
  | {
      type: 'updated';
      instanceKey: string;
      accountId: string;
      chats: Record<string, Chat>;
      messages: Record<string, Message>;
    };

export interface TabCoordinator {
  acquire(instanceKey: string): Promise<(() => void) | null>;

  announce(event: TabEvent): void;

  subscribe(listener: (event: TabEvent) => void): () => void;
}

export interface LastChatStorage {
  read(accountKey: string): string | null;

  write(accountKey: string, chatId: string): void;
}

export interface RuntimeDependencies {
  gateway(config: ConnectionConfig): MessagingGateway;

  sessions: SessionStoragePort;
  lastChat: LastChatStorage;
  tabs: TabCoordinator;

  // External state and time are supplied here so retry and recovery tests can control them.
  online(): boolean;
  visible(): boolean;
  now(): number;
  id(): string;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}
