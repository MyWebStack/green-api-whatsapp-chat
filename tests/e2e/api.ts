import { expect, type BrowserContext, type Page } from '@playwright/test';

export const testConfig = { id: '1101728000', token: 'e2e-test-token' };

export const testSettings = {
  wid: '77011234567@c.us',
  webhookUrl: '',
  incomingWebhook: 'yes',
  outgoingWebhook: 'yes',
  outgoingAPIMessageWebhook: 'yes',
  outgoingMessageWebhook: 'yes',
  stateWebhook: 'yes',
};

export function incoming(
  text: string,
  messageId = '2001',
  chatId = '77011234567@c.us',
  receiptId = 1,
) {
  return {
    receiptId,
    body: {
      typeWebhook: 'incomingMessageReceived',
      instanceData: {
        idInstance: Number(testConfig.id),
        typeInstance: 'whatsapp',
        wid: testSettings.wid,
      },
      timestamp: Math.floor(Date.now() / 1000),
      idMessage: messageId,
      senderData: {
        chatId,
        chatName: chatId === '77011234567@c.us' ? 'Анна' : 'Михаил',
      },
      messageData: {
        typeMessage: 'textMessage',
        textMessageData: { textMessage: text },
      },
    },
  };
}

export async function mockApi(context: BrowserContext) {
  const state = {
    sent: [] as { chatId: string; message: string }[],
    deleted: [] as { chatId: string; idMessage: string; onlySenderDelete: boolean }[],
    deleteError: false,
    queue: [] as unknown[],
    stateError: false,
    failSend: false,
    ackError: false,
    ackCalls: 0,
    pollCalls: 0,
    gate: null as Promise<void> | null,
    resolveGate: null as Promise<void> | null,
    resolveCalls: 0,
    resolveCompleted: 0,
    checkErrorMessage: '',
    recipientChatId: '',
    recentChats: [] as { id: string; name: string; type: string; unreadCount?: number }[],
    history: {} as Record<string, unknown[]>,
    avatarCalls: [] as string[],
    avatarUrls: {} as Record<string, string>,
    readCalls: [] as string[],
    readSuccess: true as boolean,
  };
  await context.route('https://api.green-api.com/**', async (route) => {
    const method = new URL(route.request().url()).pathname.split('/')[2];
    let body: unknown = null;
    let status = 200;

    switch (method) {
      case 'getStateInstance':
        body = { stateInstance: 'authorized' };
        if (state.stateError) status = 500;
        break;
      case 'getSettings':
        body = testSettings;
        break;
      case 'getWaSettings':
        body = { avatar: '' };
        break;
      case 'getAvatar':
        {
          const request = route.request().postDataJSON() as { chatId: string };
          state.avatarCalls.push(request.chatId);
          const urlAvatar = state.avatarUrls[request.chatId] ?? '';
          body = { available: Boolean(urlAvatar), urlAvatar };
        }
        break;
      case 'readChat':
        {
          const request = route.request().postDataJSON() as { chatId: string };
          state.readCalls.push(request.chatId);
          body = { setRead: state.readSuccess };
        }
        break;
      case 'getChats':
        body = state.recentChats;
        break;
      case 'getChatHistory': {
        const request = route.request().postDataJSON() as { chatId: string };
        body = state.history[request.chatId] ?? [];
        break;
      }
      case 'checkWhatsapp': {
        state.resolveCalls++;
        if (state.resolveGate) await state.resolveGate;
        if (state.checkErrorMessage) {
          status = 400;
          body = { message: state.checkErrorMessage };
          break;
        }
        const request = route.request().postDataJSON() as { chatId: string };
        const second = request.chatId.startsWith('77011234568');
        body = {
          existsWhatsapp: true,
          chatId: second ? '77011234568@c.us' : state.recipientChatId || '77011234567@c.us',
          username: second ? 'Михаил' : 'Анна',
        };
        break;
      }
      case 'sendMessage': {
        state.sent.push(route.request().postDataJSON() as { chatId: string; message: string });
        if (state.gate) await state.gate;
        if (state.failSend) {
          await route.abort('failed').catch(() => undefined);
          return;
        }
        body = { idMessage: String(1000 + state.sent.length) };
        break;
      }
      case 'deleteMessage': {
        state.deleted.push(
          route.request().postDataJSON() as {
            chatId: string;
            idMessage: string;
            onlySenderDelete: boolean;
          },
        );
        if (state.deleteError) {
          status = 400;
          body = { message: 'Message cannot be deleted' };
        }
        break;
      }
      case 'receiveNotification':
        state.pollCalls++;
        await new Promise((resolve) => setTimeout(resolve, 80));
        body = state.queue[0] ?? null;
        break;
      case 'deleteNotification':
        state.ackCalls++;
        if (state.ackError) {
          await route.abort('failed').catch(() => undefined);
          return;
        }
        state.queue.shift();
        body = { result: true };
        break;
    }

    await route
      .fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      })
      .catch(() => undefined);
    if (method === 'checkWhatsapp') state.resolveCompleted++;
  });

  return state;
}

export async function connect(page: Page) {
  await page.goto('/');
  await page.getByLabel('ID инстанса').fill(testConfig.id);
  await page.getByLabel('Токен API').fill(testConfig.token);
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новый чат', exact: true }).first()).toBeEnabled();
}

export async function createChat(page: Page, phone = '+7 701 123-45-67') {
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер телефона').fill(phone);
  await page.getByRole('button', { name: 'Создать чат', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toBeVisible();
}
