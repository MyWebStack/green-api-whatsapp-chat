import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { validateConfig } from '../application/config';
import { GreenApiGateway, normalizeNotification } from './green-api';
import { config, endpoint, notification, server } from '../../../tests/fixtures';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  vi.restoreAllMocks();
  server.resetHandlers();
});
afterAll(() => server.close());

const signal = () => new AbortController().signal;

describe('GREEN-API boundary', () => {
  it('does not leak credentials to untrusted URLs', () => {
    const untrustedUrls = [
      'https://evil.test',
      'http://api.green-api.com',
      'https://api.green-api.com.evil.test',
      'https://token@api.green-api.com',
      `${config.apiUrl}/v3`,
      `${config.apiUrl}?token=x`,
    ];

    for (const apiUrl of untrustedUrls) {
      expect(() => validateConfig({ ...config, apiUrl })).toThrow();
    }

    expect(validateConfig({ ...config, apiUrl: config.apiUrl + '/' }).apiUrl).toBe(config.apiUrl);
  });

  it('detects HTTP 200 business errors and provides a safe message', async () => {
    server.use(
      http.post(endpoint('checkWhatsapp'), () =>
        HttpResponse.json({ status: false, data: { reason: 'rate_limit_exceeded' } }),
      ),
    );

    await expect(
      new GreenApiGateway(config).resolvePhone('77011234567', signal()),
    ).rejects.toMatchObject({ kind: 'recipient' });
  });

  it('shows the API message when CheckWhatsapp rejects a number', async () => {
    server.use(
      http.post(endpoint('checkWhatsapp'), () =>
        HttpResponse.json({ message: 'Number check timed out' }, { status: 400 }),
      ),
    );

    await expect(new GreenApiGateway(config).resolvePhone('77011234567', signal())).rejects.toThrow(
      'GREEN-API: Number check timed out',
    );
  });

  it('also reads a nested API error message', async () => {
    server.use(
      http.post(endpoint('checkWhatsapp'), () =>
        HttpResponse.json({ status: false, data: { message: 'Contact is unavailable' } }),
      ),
    );

    await expect(new GreenApiGateway(config).resolvePhone('77011234567', signal())).rejects.toThrow(
      'GREEN-API: Contact is unavailable',
    );
  });

  it('reports a webhook configuration error returned with HTTP 200', async () => {
    server.use(
      http.get(endpoint('receiveNotification'), () =>
        HttpResponse.json({
          status: 'error',
          code: 'INVALID_PARAM',
          message: 'Message cannot be received because custom webhook url is set',
        }),
      ),
    );

    await expect(new GreenApiGateway(config).receive(signal())).rejects.toMatchObject({
      kind: 'configuration',
      message: expect.stringContaining('Webhook URL'),
    });
  });

  it('reports a phone without a WhatsApp account', async () => {
    server.use(
      http.post(endpoint('checkWhatsapp'), () =>
        HttpResponse.json({ existsWhatsapp: false, chatId: '' }),
      ),
    );

    await expect(new GreenApiGateway(config).resolvePhone('77011234567', signal())).rejects.toThrow(
      'не найден',
    );
  });

  it('does not interpret a missing incomingWebhook setting as disabled', async () => {
    server.use(
      http.get(endpoint('getSettings'), () =>
        HttpResponse.json({ wid: '77011234567@c.us', webhookUrl: '' }),
      ),
    );

    await expect(new GreenApiGateway(config).getSettings(signal())).rejects.toMatchObject({
      kind: 'protocol',
      message: 'Не удалось прочитать настройки инстанса.',
    });
  });

  it('ignores an unsafe account photo URL', async () => {
    server.use(
      http.get(endpoint('getWaSettings'), () =>
        HttpResponse.json({ avatar: 'javascript:alert(1)' }),
      ),
    );

    await expect(new GreenApiGateway(config).getAccountAvatar(signal())).resolves.toBe('');
  });

  it('reads a correspondent photo only when it is available', async () => {
    const requests: string[] = [];
    server.use(
      http.post(endpoint('getAvatar'), async ({ request }) => {
        const { chatId } = (await request.json()) as { chatId: string };
        requests.push(chatId);
        return HttpResponse.json(
          chatId.endsWith('@lid')
            ? { available: false, urlAvatar: 'https://pps.whatsapp.net/hidden.jpg' }
            : { available: true, urlAvatar: 'https://pps.whatsapp.net/contact.jpg' },
        );
      }),
    );

    const gateway = new GreenApiGateway(config);
    await expect(gateway.getChatAvatar('77011234567@c.us', signal())).resolves.toBe(
      'https://pps.whatsapp.net/contact.jpg',
    );
    await expect(gateway.getChatAvatar('120650379300963@lid', signal())).resolves.toBe('');
    expect(requests).toEqual(['77011234567@c.us', '120650379300963@lid']);
  });

  it('requires a confirmed read mark before clearing unread messages', async () => {
    server.use(http.post(endpoint('readChat'), () => HttpResponse.json({ setRead: false })));
    await expect(
      new GreenApiGateway(config).markChatRead('77011234567@c.us', signal()),
    ).resolves.toBe(false);
  });

  it('sends the original message ID and delete scope', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(endpoint('deleteMessage'), async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const gateway = new GreenApiGateway(config);
    await gateway.deleteMessage('77011234567@c.us', 'server-1', true, signal());
    await gateway.deleteMessage('77011234567@c.us', 'server-2', false, signal());

    expect(bodies).toEqual([
      { chatId: '77011234567@c.us', idMessage: 'server-1', onlySenderDelete: true },
      { chatId: '77011234567@c.us', idMessage: 'server-2', onlySenderDelete: false },
    ]);
  });

  it('loads only personal chats and normalizes bare phone IDs', async () => {
    let requestedUrl = '';
    server.use(
      http.get(endpoint('getChats'), ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json([
          { id: '77011234567', name: 'Айгуль', type: 'user', unreadCount: 3 },
          { id: '120650379300963@lid', name: 'Али', type: 'user' },
          { id: '123-456@g.us', name: 'Группа', type: 'group' },
          { id: 'invalid', name: 'Ошибка', type: 'user' },
        ]);
      }),
    );

    await expect(new GreenApiGateway(config).getChats(signal())).resolves.toEqual([
      { id: '77011234567@c.us', name: 'Айгуль', phone: '77011234567', unreadCount: 3 },
      { id: '120650379300963@lid', name: 'Али', phone: undefined, unreadCount: undefined },
    ]);
    expect(new URL(requestedUrl).search).toBe('');
  });

  it('reads text history in chronological order and skips non-text messages', async () => {
    let requestBody: unknown;
    server.use(
      http.post(endpoint('getChatHistory'), async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json([
          {
            idMessage: 'new',
            type: 'outgoing',
            typeMessage: 'extendedTextMessage',
            textMessage: 'Новый текст',
            timestamp: 1_790_000_100,
          },
          { type: 'incoming', typeMessage: 'imageMessage' },
          {
            idMessage: 'old',
            type: 'incoming',
            typeMessage: 'textMessage',
            textMessage: 'Старый текст',
            timestamp: 1_790_000_000,
          },
        ]);
      }),
    );

    const history = await new GreenApiGateway(config).getChatHistory(
      '77011234567@c.us',
      100,
      signal(),
    );

    expect(requestBody).toEqual({ chatId: '77011234567@c.us', count: 100 });
    expect(history.map((message) => message.text)).toEqual(['Старый текст', 'Новый текст']);
  });

  it('checks WhatsApp by chatId and uses the returned lid for sending', async () => {
    let requestBody: unknown;
    server.use(
      http.post(endpoint('checkWhatsapp'), async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          existsWhatsapp: true,
          chatId: '120650379300963@lid',
          username: 'Анна',
        });
      }),
    );

    const recipient = await new GreenApiGateway(config).resolvePhone('77011234567', signal());

    expect(requestBody).toEqual({ chatId: '77011234567@c.us', force: true });
    expect(recipient).toEqual({ chatId: '120650379300963@lid', name: 'Анна' });
  });

  it('uses the phone chatId when CheckWhatsapp omits an optional chatId', async () => {
    server.use(
      http.post(endpoint('checkWhatsapp'), () =>
        HttpResponse.json({ existsWhatsapp: true, username: '' }),
      ),
    );

    await expect(
      new GreenApiGateway(config).resolvePhone('77011234567', signal()),
    ).resolves.toEqual({ chatId: '77011234567@c.us', name: '+77011234567' });
  });

  it('treats empty receive responses and JSON null as idle', async () => {
    const api = new GreenApiGateway(config);

    expect(await api.receive(signal())).toBeNull();

    server.use(
      http.get(endpoint('receiveNotification'), () => new HttpResponse(null, { status: 204 })),
    );

    expect(await api.receive(signal())).toBeNull();
  });

  it('treats the receive long-poll timeout as an idle queue', async () => {
    const timeout = new AbortController();
    timeout.abort(new DOMException('Waiting ended', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout.signal);

    await expect(new GreenApiGateway(config).receive(signal())).resolves.toBeNull();
  });

  it.each([408, 504])('verifies the instance after HTTP %s from the long poll', async (status) => {
    server.use(
      http.get(endpoint('receiveNotification'), ({ request }) => {
        expect(new URL(request.url).searchParams.get('receiveTimeout')).toBe('5');
        return new HttpResponse('Timeout', { status });
      }),
    );

    await expect(new GreenApiGateway(config).receive(signal())).resolves.toBeNull();
  });

  it('continues polling after a transport failure when the instance is reachable', async () => {
    server.use(http.get(endpoint('receiveNotification'), () => HttpResponse.error()));

    await expect(new GreenApiGateway(config).receive(signal())).resolves.toBeNull();
  });

  it('reports a real outage when the connection check also fails', async () => {
    server.use(
      http.get(endpoint('receiveNotification'), () => new HttpResponse(null, { status: 504 })),
      http.get(endpoint('getStateInstance'), () => HttpResponse.error()),
    );

    await expect(new GreenApiGateway(config).receive(signal())).rejects.toMatchObject({
      kind: 'temporary',
    });
  });

  it('does not hide lost authorization behind a receive timeout', async () => {
    server.use(
      http.get(endpoint('receiveNotification'), () => new HttpResponse(null, { status: 504 })),
      http.get(endpoint('getStateInstance'), () =>
        HttpResponse.json({ stateInstance: 'notAuthorized' }),
      ),
    );

    await expect(new GreenApiGateway(config).receive(signal())).rejects.toMatchObject({
      kind: 'configuration',
    });
  });

  it('does not treat rate limits or other server failures as an idle queue', async () => {
    for (const status of [429, 500, 502, 503]) {
      server.use(
        http.get(endpoint('receiveNotification'), () => new HttpResponse(null, { status })),
      );
      await expect(new GreenApiGateway(config).receive(signal())).rejects.toMatchObject({
        httpStatus: status,
      });
    }
  });

  it('does not check connection or retry after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const getState = vi.spyOn(GreenApiGateway.prototype, 'getState');

    await expect(new GreenApiGateway(config).receive(controller.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(getState).not.toHaveBeenCalled();
  });

  it('maps auth errors without exposing an echoed URL or token', async () => {
    server.use(
      http.get(endpoint('getStateInstance'), () =>
        HttpResponse.json(
          {
            message: `Request ${endpoint('getStateInstance')} failed for ${config.apiTokenInstance}`,
          },
          { status: 401 },
        ),
      ),
    );

    try {
      await new GreenApiGateway(config).getState(signal());
    } catch (error) {
      expect(String(error)).not.toContain(config.apiTokenInstance);
      expect(String(error)).toContain('Request [адрес скрыт] failed for [токен скрыт]');
      expect(error).toMatchObject({ kind: 'auth' });
    }
  });

  it('honors Retry-After on safe read requests', async () => {
    server.use(
      http.get(
        endpoint('getStateInstance'),
        () =>
          new HttpResponse('', {
            status: 429,
            headers: { 'Retry-After': '5' },
          }),
      ),
    );

    await expect(new GreenApiGateway(config).getState(signal())).rejects.toMatchObject({
      kind: 'rate',
      retryAfterMs: 5000,
    });
  });

  it('reports an uncertain send response without claiming a queue failure', async () => {
    server.use(http.post(endpoint('sendMessage'), () => HttpResponse.json({ unexpected: true })));

    await expect(
      new GreenApiGateway(config).sendText('77011234567@c.us', 'Привет', signal()),
    ).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('подтверждение отправки'),
    });
  });

  it('validates text notifications and preserves large string identifiers', () => {
    const parsed = normalizeNotification(notification('9007199254740993999'), config.idInstance);

    expect(parsed?.event).toMatchObject({ kind: 'message', serverId: '9007199254740993999' });

    const extended = notification();
    const body = {
      ...extended.body,
      messageData: {
        typeMessage: 'extendedTextMessage',
        extendedTextMessageData: { text: 'https://example.com' },
      },
    };

    expect(
      normalizeNotification(
        {
          ...extended,
          body,
        },
        config.idInstance,
      )?.event,
    ).toMatchObject({ text: 'https://example.com' });
  });

  it('ignores delivery notifications without blocking the queue', () => {
    const item = notification();
    const event = normalizeNotification(
      {
        ...item,
        body: {
          typeWebhook: 'outgoingMessageStatus',
          instanceData: item.body.instanceData,
          chatId: '77011234567@c.us',
          timestamp: 1_700_000_000,
          status: 'noAccount',
        },
      },
      config.idInstance,
    );

    expect(event?.event).toEqual({ kind: 'ignore' });
  });

  it('does not confuse a blocked contact with a tariff limit', () => {
    const item = notification();
    const blockedContact = normalizeNotification(
      { ...item, body: { ...item.body, typeWebhook: 'incomingBlock' } },
      config.idInstance,
    );
    const quota = normalizeNotification(
      { ...item, body: { ...item.body, typeWebhook: 'quotaExceeded' } },
      config.idInstance,
    );

    expect(blockedContact?.event).toEqual({ kind: 'ignore' });
    expect(quota?.event).toEqual({ kind: 'limit' });
  });

  it('accepts personal lid webhooks and ignores group messages', () => {
    const item = notification();
    const lid = normalizeNotification(
      { ...item, body: { ...item.body, senderData: { chatId: '120650379300963@lid' } } },
      config.idInstance,
    );
    const group = normalizeNotification(
      { ...item, body: { ...item.body, senderData: { chatId: '120363043968066561@g.us' } } },
      config.idInstance,
    );

    expect(lid?.event).toMatchObject({ kind: 'message', chatId: '120650379300963@lid' });
    expect(group?.event).toEqual({ kind: 'ignore' });
  });

  it('ignores unsupported events and identifies malformed supported text', () => {
    const item = notification();

    expect(
      normalizeNotification(
        {
          ...item,
          body: { ...item.body, typeWebhook: 'newFutureEvent' },
        },
        config.idInstance,
      )?.event.kind,
    ).toBe('ignore');
    expect(
      normalizeNotification(
        {
          ...item,
          body: { ...item.body, messageData: { typeMessage: 'textMessage' } },
        },
        config.idInstance,
      ),
    ).toEqual({ receiptId: item.receiptId, event: { kind: 'invalid' } });
  });
  it('rejects a notification belonging to another instance', () => {
    expect(() => normalizeNotification(notification(), '1101728001')).toThrow();
  });

  it('rejects a webhook from a non-WhatsApp instance', () => {
    const item = notification();
    expect(() =>
      normalizeNotification(
        {
          ...item,
          body: {
            ...item.body,
            instanceData: { ...item.body.instanceData, typeInstance: 'v3' },
          },
        },
        config.idInstance,
      ),
    ).toThrow('другого инстанса');
  });

  it('identifies timestamps that cannot be rendered as a date', () => {
    const item = notification();
    expect(
      normalizeNotification(
        { ...item, body: { ...item.body, timestamp: 9_000_000_000_000 } },
        config.idInstance,
      )?.event,
    ).toEqual({ kind: 'invalid' });
  });
});
