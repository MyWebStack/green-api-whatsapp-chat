import { z } from 'zod';
import type {
  RuntimeDependencies,
  SavedSession,
  SessionStoragePort,
  TabCoordinator,
  TabEvent,
} from '../chat/application/ports';
import { AppError } from '../chat/application/errors';
import { validateConfig } from '../chat/application/config';
import { lastChatStorage } from './last-chat';
import { GreenApiGateway } from '../chat/infrastructure/green-api';

export const SESSION_KEY = 'dialog.whatsapp.connection.v1';
const LEGACY_SESSION_KEY = 'dialog.connection.v1';
const savedSchema = z.object({
  config: z.object({ apiUrl: z.string(), idInstance: z.string(), apiTokenInstance: z.string() }),
  accountId: z.string(),
});

export class BrowserSessionStorage implements SessionStoragePort {
  read(): SavedSession | null {
    try {
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const value = savedSchema.parse(JSON.parse(raw) as unknown);
      return { ...value, config: validateConfig(value.config) };
    } catch {
      this.clear();
      return null;
    }
  }

  write(value: SavedSession) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
    } catch {
      /* Browser storage can be disabled. */
    }
  }
}

export class BrowserTabs implements TabCoordinator {
  private channel?: BroadcastChannel;
  private listeners = new Set<(event: TabEvent) => void>();

  acquire(instanceKey: string): Promise<(() => void) | null> {
    if (!navigator.locks) {
      return Promise.reject(
        new AppError(
          'configuration',
          'Откройте приложение по HTTPS в актуальном браузере: требуется поддержка Web Locks.',
        ),
      );
    }

    return new Promise((resolve, reject) => {
      void navigator.locks
        .request(`dialog:${instanceKey}`, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          await new Promise<void>((release) => resolve(release));
        })
        .catch(reject);
    });
  }

  announce(event: TabEvent) {
    this.channel?.postMessage(event);
  }

  subscribe(listener: (event: TabEvent) => void) {
    this.listeners.add(listener);
    if (!this.channel && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('dialog.sessions.v1');
      this.channel.onmessage = ({ data }: MessageEvent<TabEvent>) => {
        if (!data || typeof data.instanceKey !== 'string') return;
        if (data.type !== 'logout' && data.type !== 'updated') return;
        for (const notify of this.listeners) notify(data);
      };
    }

    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.channel?.close();
        this.channel = undefined;
      }
    };
  }
}

export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError('cancelled', 'Операция отменена.'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new AppError('cancelled', 'Операция отменена.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export const browserDependencies = (): RuntimeDependencies => ({
  gateway: (config) => new GreenApiGateway(config),
  sessions: new BrowserSessionStorage(),
  lastChat: lastChatStorage,
  tabs: new BrowserTabs(),
  online: () => navigator.onLine,
  visible: () => document.visibilityState === 'visible',
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
  wait: abortableWait,
  random: Math.random,
});
