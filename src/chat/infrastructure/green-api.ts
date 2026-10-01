import { z } from 'zod';
import { AppError } from '../application/errors';
import { validateConfig } from '../application/config';
import type {
  ConnectionConfig,
  MessagingGateway,
  NotificationEnvelope,
} from '../application/ports';
import { MAX_DATE_MS, type ChatEvent } from '../domain/model';

const unknownRecordSchema = z.record(z.string(), z.unknown());
const personalChatIdSchema = z.string().regex(/^\d+@(c\.us|lid)$/);
const apiTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_DATE_MS / 1000);
const webhookFlagSchema = z.enum(['yes', 'no']);
const settingsSchema = z.object({
  wid: z.string().min(1),
  typeInstance: z.string().optional(),
  webhookUrl: z.string(),
  incomingWebhook: webhookFlagSchema,
});

function parse<T>(schema: z.ZodType<T>, value: unknown, errorMessage: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('protocol', errorMessage);
  return result.data;
}

function safeImageUrl(value: string): string {
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

const invalidNotification =
  'Сервис вернул некорректное уведомление. Получение остановлено, уведомление осталось в очереди.';

function parseNotification<T>(schema: z.ZodType<T>, value: unknown): T {
  return parse(schema, value, invalidNotification);
}

function parseMessageEvent(body: Record<string, unknown>, type: string): ChatEvent {
  const sender = parseNotification(
    z.object({
      chatId: z.string(),
      chatType: z.string().optional(),
      chatName: z.string().optional(),
      senderName: z.string().optional(),
    }),
    body.senderData,
  );
  const message = parseNotification(unknownRecordSchema, body.messageData);
  const messageType = parseNotification(z.string(), message.typeMessage);
  const isPersonalChat =
    personalChatIdSchema.safeParse(sender.chatId).success &&
    (!sender.chatType || sender.chatType === 'user');
  if (!isPersonalChat || (messageType !== 'textMessage' && messageType !== 'extendedTextMessage')) {
    return { kind: 'ignore' };
  }

  const text =
    messageType === 'textMessage'
      ? parseNotification(z.object({ textMessage: z.string() }), message.textMessageData)
          .textMessage
      : parseNotification(z.object({ text: z.string() }), message.extendedTextMessageData).text;
  return {
    kind: 'message',
    chatId: sender.chatId,
    serverId: parseNotification(z.string().min(1), body.idMessage),
    name: sender.chatName || sender.senderName || sender.chatId,
    phone: sender.chatId.endsWith('@c.us') ? sender.chatId.slice(0, -5) : undefined,
    text,
    direction: type === 'incomingMessageReceived' ? 'incoming' : 'outgoing',
    at: parseNotification(apiTimestampSchema, body.timestamp) * 1000,
  };
}

export function normalizeNotification(
  value: unknown,
  expectedInstance: string,
): NotificationEnvelope | null {
  if (value === null || value === undefined) return null;
  const envelope = parseNotification(
    z.object({ receiptId: z.number().int().nonnegative().safe(), body: unknownRecordSchema }),
    value,
  );
  const body = envelope.body;
  const identity = parseNotification(
    z.object({
      idInstance: z.union([z.number().int().safe(), z.string()]),
      typeInstance: z.string(),
    }),
    body.instanceData,
  );
  if (String(identity.idInstance) !== expectedInstance || identity.typeInstance !== 'whatsapp') {
    throw new AppError(
      'protocol',
      'Получено уведомление другого инстанса. Переподключитесь к сервису.',
    );
  }
  const type = parseNotification(z.string(), body.typeWebhook);
  let event: ChatEvent = { kind: 'ignore' };
  try {
    if (type === 'stateInstanceChanged') {
      event = { kind: 'state', state: parseNotification(z.string(), body.stateInstance) };
    } else if (type === 'quotaExceeded') {
      event = { kind: 'limit' };
    } else if (
      ['incomingMessageReceived', 'outgoingAPIMessageReceived', 'outgoingMessageReceived'].includes(
        type,
      )
    ) {
      event = parseMessageEvent(body, type);
    }
  } catch (error) {
    if (!(error instanceof AppError) || error.kind !== 'protocol') throw error;
    event = { kind: 'invalid' };
  }
  return { receiptId: envelope.receiptId, event };
}

function apiMessage(value: unknown, apiTokenInstance: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .trim()
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[адрес скрыт]')
    .replaceAll(apiTokenInstance, '[токен скрыт]')
    .slice(0, 500);
}

function apiFailure(
  status: number,
  value: unknown,
  apiTokenInstance: string,
  retryAfterMs?: number,
): AppError {
  const result = unknownRecordSchema.safeParse(value);
  const data = result.success ? result.data : {};
  const nested = unknownRecordSchema.safeParse(data.data);
  const message =
    apiMessage(data.message, apiTokenInstance) ||
    apiMessage(nested.success ? nested.data.message : undefined, apiTokenInstance);
  const describe = (fallback: string) => (message ? `${fallback} GREEN-API: ${message}` : fallback);
  const detail =
    `${String(data.error || '')} ${String(data.reason || '')} ${String(data.message || '')} ${JSON.stringify(data.data || {})}`.toLowerCase();
  if (status === 401 || status === 403) {
    return new AppError(
      'auth',
      describe('Не удалось подтвердить подключение. Проверьте ID, токен и адрес API.'),
      status,
    );
  }
  if (status === 429) {
    return new AppError(
      'rate',
      describe('Слишком много запросов. Подождите немного.'),
      status,
      retryAfterMs,
    );
  }
  if (status === 469 || detail.includes('rate_limit') || detail.includes('rate limited')) {
    return new AppError(
      'recipient',
      describe('WhatsApp временно ограничил проверку номеров. Повторите попытку позже.'),
      status,
    );
  }
  if (detail.includes('webhook')) {
    return new AppError(
      'configuration',
      describe(
        'Очистите Webhook URL в кабинете GREEN-API, подождите минуту и повторите подключение.',
      ),
      status,
    );
  }
  if (detail.includes('not authorized')) {
    return new AppError(
      'configuration',
      describe('Авторизуйте WhatsApp-инстанс в кабинете GREEN-API.'),
      status,
    );
  }
  if (detail.includes('starting')) {
    return new AppError(
      'temporary',
      describe('Инстанс запускается. Повторяем подключение…'),
      status,
    );
  }
  if (detail.includes('expired') || detail.includes('deleted')) {
    return new AppError(
      'configuration',
      describe('Проверьте доступность и срок действия инстанса в кабинете GREEN-API.'),
      status,
    );
  }
  if (status >= 500 || status === 499 || status === 408) {
    return new AppError(
      'temporary',
      describe('Сервис временно недоступен. Соединение будет восстановлено.'),
      status,
    );
  }
  return new AppError(
    'configuration',
    describe('Сервис отклонил запрос. Проверьте параметры и настройки инстанса.'),
    status,
  );
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Math.max(0, Date.parse(header) - Date.now());
  return Number.isFinite(delay) ? delay : undefined;
}

export class GreenApiGateway implements MessagingGateway {
  private readonly config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = validateConfig(config);
  }

  private async request(
    method: string,
    verb: string,
    signal: AbortSignal,
    body?: unknown,
    suffix = '',
    timeout = 20_000,
  ): Promise<unknown> {
    const { apiUrl, idInstance, apiTokenInstance } = this.config;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    try {
      const response = await fetch(
        `${apiUrl}/waInstance${idInstance}/${method}/${apiTokenInstance}${suffix}`,
        {
          method: verb,
          signal: combined,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        },
      );
      const text = await response.text();
      let value: unknown = null;
      try {
        value = text.trim() ? (JSON.parse(text) as unknown) : null;
      } catch {
        if (!response.ok) throw apiFailure(response.status, null, apiTokenInstance);
        throw new AppError(
          'protocol',
          'Не удалось прочитать ответ сервиса. Повторите подключение.',
        );
      }
      const responseObject = unknownRecordSchema.safeParse(value);
      if (
        !response.ok ||
        (responseObject.success &&
          (responseObject.data.status === false || responseObject.data.status === 'error'))
      ) {
        throw apiFailure(
          response.status,
          value,
          apiTokenInstance,
          retryAfterMs(response.headers.get('Retry-After')),
        );
      }
      return value;
    } catch (error) {
      if (signal.aborted) throw new AppError('cancelled', 'Операция отменена.');
      if (error instanceof AppError) throw error;
      throw new AppError('temporary', 'Не удалось получить ответ сервиса. Проверьте соединение.');
    }
  }

  async getState(signal: AbortSignal) {
    return parse(
      z.object({ stateInstance: z.string() }),
      await this.request('getStateInstance', 'GET', signal),
      'Не удалось прочитать состояние инстанса.',
    ).stateInstance;
  }

  async getSettings(signal: AbortSignal) {
    return parse(
      settingsSchema,
      await this.request('getSettings', 'GET', signal),
      'Не удалось прочитать настройки инстанса.',
    );
  }

  async getAccountAvatar(signal: AbortSignal) {
    const { avatar } = parse(
      z.object({ avatar: z.string() }),
      await this.request('getWaSettings', 'GET', signal),
      'Не удалось прочитать профиль WhatsApp.',
    );
    return safeImageUrl(avatar);
  }

  async getChatAvatar(chatId: string, signal: AbortSignal) {
    const { available, urlAvatar } = parse(
      z.object({ available: z.boolean(), urlAvatar: z.string() }),
      await this.request('getAvatar', 'POST', signal, { chatId }),
      'Не удалось прочитать фото собеседника.',
    );
    return available ? safeImageUrl(urlAvatar) : '';
  }

  async markChatRead(chatId: string, signal: AbortSignal) {
    const { setRead } = parse(
      z.object({ setRead: z.boolean() }),
      await this.request('readChat', 'POST', signal, { chatId }),
      'Не удалось отметить чат прочитанным.',
    );
    return setRead;
  }

  async getChats(signal: AbortSignal) {
    const rows = parse(
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          unreadCount: z.number().int().nonnegative().optional(),
        }),
      ),
      await this.request('getChats', 'GET', signal, undefined, '', 45_000),
      'Не удалось прочитать список чатов.',
    );

    return rows.flatMap(({ id, name, type, unreadCount }) => {
      if (type !== 'user') return [];
      const chatId = /^\d+$/.test(id) ? `${id}@c.us` : id;
      if (!personalChatIdSchema.safeParse(chatId).success) return [];
      return [
        {
          id: chatId,
          name,
          phone: chatId.endsWith('@c.us') ? chatId.slice(0, -5) : undefined,
          unreadCount,
        },
      ];
    });
  }

  async getChatHistory(chatId: string, count: number, signal: AbortSignal) {
    const rows = parse(
      z.array(unknownRecordSchema),
      await this.request('getChatHistory', 'POST', signal, { chatId, count }),
      'Не удалось прочитать историю чата.',
    );
    const textRowSchema = z.object({
      idMessage: z.string().min(1),
      timestamp: apiTimestampSchema,
      type: z.enum(['incoming', 'outgoing']),
      textMessage: z.string().optional(),
      extendedTextMessage: z.object({ text: z.string() }).optional(),
    });

    return rows
      .filter(
        (row) =>
          (row.typeMessage === 'textMessage' || row.typeMessage === 'extendedTextMessage') &&
          row.isDeleted !== true,
      )
      .map((row) => {
        const message = parse(textRowSchema, row, 'Не удалось прочитать историю чата.');
        const text = message.textMessage ?? message.extendedTextMessage?.text;
        if (text === undefined) {
          throw new AppError('protocol', 'Не удалось прочитать историю чата.');
        }
        return {
          kind: 'message' as const,
          serverId: message.idMessage,
          chatId,
          name: '',
          text,
          direction: message.type,
          at: message.timestamp * 1000,
        };
      })
      .reverse();
  }

  async resolvePhone(phone: string, signal: AbortSignal) {
    const data = parse(
      z.object({
        existsWhatsapp: z.boolean(),
        chatId: z.string().optional(),
        username: z.string().optional(),
      }),
      await this.request('checkWhatsapp', 'POST', signal, { chatId: `${phone}@c.us`, force: true }),
      'Не удалось прочитать результат проверки номера.',
    );
    if (!data.existsWhatsapp) {
      throw new AppError('recipient', 'Аккаунт WhatsApp на этом номере не найден.');
    }
    const chatId = data.chatId || `${phone}@c.us`;
    if (!personalChatIdSchema.safeParse(chatId).success) {
      throw new AppError('protocol', 'Сервис вернул некорректный идентификатор получателя.');
    }
    return { chatId, name: data.username || `+${phone}` };
  }

  async sendText(chatId: string, text: string, signal: AbortSignal) {
    return parse(
      z.object({ idMessage: z.string().min(1) }),
      await this.request('sendMessage', 'POST', signal, { chatId, message: text }),
      'Сервис вернул некорректное подтверждение отправки. Проверьте сообщение в WhatsApp.',
    );
  }

  async deleteMessage(
    chatId: string,
    idMessage: string,
    onlySenderDelete: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await this.request('deleteMessage', 'POST', signal, { chatId, idMessage, onlySenderDelete });
  }

  async receive(signal: AbortSignal) {
    try {
      return normalizeNotification(
        await this.request('receiveNotification', 'GET', signal, undefined, '?receiveTimeout=10'),
        this.config.idInstance,
      );
    } catch (error) {
      const canCheckConnection =
        error instanceof AppError &&
        error.kind === 'temporary' &&
        (error.httpStatus === undefined || error.httpStatus === 408 || error.httpStatus === 504);
      if (!canCheckConnection) throw error;

      // A failed long poll does not tell us whether the instance is offline.
      // Verify it with a short request before changing the connection status.
      const state = await this.getState(signal);
      if (state === 'authorized') return null;
      if (state === 'starting') throw error;
      throw new AppError(
        'configuration',
        'Инстанс недоступен. Проверьте авторизацию WhatsApp в кабинете GREEN-API.',
      );
    }
  }

  async acknowledge(receiptId: number, signal: AbortSignal) {
    return parse(
      z.object({ result: z.boolean() }),
      await this.request('deleteNotification', 'DELETE', signal, undefined, `/${receiptId}`),
      'Не удалось подтвердить обработку уведомления.',
    ).result;
  }
}
