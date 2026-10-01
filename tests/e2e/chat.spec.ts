import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { connect, createChat, incoming, mockApi } from './api';

test('send, receive and restore the connection and last chat after reload @smoke', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await connect(page);
  await createChat(page);

  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });

  await input.fill('Привет из приложения');
  await input.press('Enter');

  await expect(
    page.getByRole('log').getByText('Привет из приложения', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();

  api.queue.push(incoming('Привет из WhatsApp'));

  await expect(page.getByRole('log').getByText('Привет из WhatsApp')).toBeVisible();

  api.recentChats = [{ id: '77011234567@c.us', name: 'Анна', type: 'user' }];
  await input.fill('Мой сохранённый черновик');
  let finishState!: () => void;
  const pendingState = new Promise<void>((resolve) => {
    finishState = resolve;
  });
  await page.route('**/getStateInstance/**', async (route) => {
    await pendingState;
    await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Список чатов' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Начните диалог' })).toHaveCount(0);
  finishState();
  await expect(page.getByRole('button', { name: 'Новый чат', exact: true }).first()).toBeEnabled();
  await expect(page.getByRole('log')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Анна', exact: true })).toBeVisible();
  await expect(page.getByText('Привет из WhatsApp', { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue('');
  expect(api.sent).toEqual([{ chatId: '77011234567@c.us', message: 'Привет из приложения' }]);
  expect(errors).toEqual([]);
});

test('creates a chat and sends the first message to the resolved recipient', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  api.recipientChatId = '120650379300963@lid';
  await connect(page);
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер телефона').fill('+7 701 123-45-67');
  await page
    .getByLabel('Первое сообщение (опционально)')
    .fill('Привет!\nКогда удобно созвониться?');
  await page.getByRole('button', { name: 'Создать и отправить', exact: true }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('log').getByText('Привет!\nКогда удобно созвониться?')).toBeVisible();
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();
  expect(api.sent).toEqual([
    { chatId: api.recipientChatId, message: 'Привет!\nКогда удобно созвониться?' },
  ]);
});

test('keeps the first message in the chat when the send result is unknown', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  api.failSend = true;
  await connect(page);
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер телефона').fill('+7 701 123-45-67');
  await page.getByLabel('Первое сообщение (опционально)').fill('Первое сообщение');
  await page.getByRole('button', { name: 'Создать и отправить', exact: true }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('log').getByText('Первое сообщение', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Результат неизвестен', { exact: true })).toBeVisible();
  expect(api.sent).toHaveLength(1);
});

test('deletes an outgoing message for everyone from its context menu', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Сообщение для удаления');
  await input.press('Enter');
  const message = page.getByRole('article', { name: 'Сообщение от вас' });
  await expect(message.getByText('Сообщение для удаления')).toBeVisible();
  await expect(message.getByLabel('Принято API')).toBeVisible();

  await message.click({ button: 'right', position: { x: 5, y: 5 } });
  await expect(page.getByRole('group', { name: 'Действия с сообщением' })).toHaveCount(0);
  await message.getByText('Сообщение для удаления', { exact: true }).click({ button: 'right' });
  await page
    .getByRole('group', { name: 'Действия с сообщением' })
    .getByRole('button', { name: 'Удалить у всех' })
    .click();
  await page
    .getByRole('dialog', { name: 'Удалить сообщение?' })
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();

  await expect(message.getByText('Сообщение удалено')).toBeVisible();
  expect(api.deleted).toEqual([
    { chatId: '77011234567@c.us', idMessage: '1001', onlySenderDelete: false },
  ]);
  await page.reload();
  await createChat(page);
  await expect(page.getByText('Сообщение для удаления', { exact: true })).toHaveCount(0);
});

test('keeps the message when GREEN-API rejects deletion', async ({ page, context }) => {
  const api = await mockApi(context);
  api.deleteError = true;
  await connect(page);
  await createChat(page);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Исходящее сообщение');
  await input.press('Enter');
  const message = page.getByRole('article', { name: 'Сообщение от вас' });
  await expect(message.getByLabel('Принято API')).toBeVisible();

  await message.getByText('Исходящее сообщение', { exact: true }).click({ button: 'right' });
  await page
    .getByRole('group', { name: 'Действия с сообщением' })
    .getByRole('button', { name: 'Удалить у себя' })
    .click();
  await expect(page.getByRole('group', { name: 'Действия с сообщением' })).toHaveCount(0);
  await page
    .getByRole('dialog', { name: 'Удалить сообщение?' })
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();

  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Message cannot be deleted',
  );
  await expect(message.getByText('Исходящее сообщение')).toBeVisible();
  expect(api.deleted).toEqual([
    { chatId: '77011234567@c.us', idMessage: '1001', onlySenderDelete: true },
  ]);

  api.deleteError = false;
  await page
    .getByRole('dialog', { name: 'Удалить сообщение?' })
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  await expect(message.getByText('Сообщение удалено')).toBeVisible();
  expect(api.deleted).toHaveLength(2);
});

test('does not offer deletion for incoming messages', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);
  api.queue.push(incoming('Входящее сообщение'));
  const message = page.getByRole('article', { name: 'Сообщение от Анна' });
  await expect(message.getByText('Входящее сообщение')).toBeVisible();

  await expect(message.getByRole('button', { name: 'Действия с сообщением' })).toHaveCount(0);
  await message.click({ button: 'right' });
  await expect(page.getByRole('group', { name: 'Действия с сообщением' })).toHaveCount(0);
  expect(api.deleted).toEqual([]);
});

test('recent personal chats appear after login @smoke', async ({ page, context }) => {
  const api = await mockApi(context);
  api.recentChats = [
    { id: '77011234567@c.us', name: 'Айгуль', type: 'user' },
    { id: '77011234568@c.us', name: 'Михаил', type: 'user' },
    { id: '123-456@g.us', name: 'Группа', type: 'group' },
  ];
  api.history['77011234567@c.us'] = [
    {
      idMessage: 'historic-1',
      chatId: '77011234567@c.us',
      type: 'incoming',
      typeMessage: 'textMessage',
      textMessage: 'Старое сообщение',
      timestamp: 1_790_000_000,
    },
  ];

  await connect(page);
  const list = page.getByRole('navigation', { name: 'Список чатов' });
  await expect(list.getByRole('button', { name: /Айгуль/ })).toBeVisible();
  await expect(list.getByText('Группа')).toHaveCount(0);
  await list.getByRole('button', { name: /Айгуль/ }).click();
  await expect(page.getByRole('log').getByText('Старое сообщение')).toBeVisible();
  await expect(list.getByRole('button').first()).toContainText('Айгуль');
});

test('shows the API message when a phone check fails', async ({ page, context }) => {
  const api = await mockApi(context);
  api.checkErrorMessage = 'Number check timed out';

  await connect(page);
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер телефона').fill('+7 701 123-45-67');
  await page.getByRole('button', { name: 'Создать чат', exact: true }).click();

  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'GREEN-API: Number check timed out',
  );
});

test('searches chats and loads a photo only after opening one', async ({ page, context }) => {
  const api = await mockApi(context);
  const first = '77011234567@c.us';
  const second = '77011234568@c.us';
  const avatarUrl = 'https://pps.whatsapp.net/contact.svg';
  api.recentChats = [
    { id: first, name: 'Айгуль', type: 'user', unreadCount: 3 },
    { id: second, name: 'Михаил', type: 'user', unreadCount: 0 },
    ...Array.from({ length: 120 }, (_, index) => ({
      id: `${77020000000 + index}@c.us`,
      name: `Контакт ${index + 1}`,
      type: 'user',
      unreadCount: 0,
    })),
  ];
  api.avatarUrls[first] = avatarUrl;
  await context.route(avatarUrl, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="24" fill="green"/></svg>',
    }),
  );

  await connect(page);
  const list = page.getByRole('navigation', { name: 'Список чатов' });
  await expect(list.getByLabel('Непрочитанных сообщений: 3')).toBeVisible();
  await expect(page).toHaveTitle('(3) Диалог — WhatsApp через GREEN-API');
  expect(api.avatarCalls).toEqual([]);

  const search = page.getByRole('searchbox', { name: 'Поиск по чатам' });
  await expect(page.getByRole('heading', { name: 'Чаты 122' })).toBeVisible();
  await search.fill('Контакт 120');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('Контакт 120');
  await search.fill('Михаил');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('Михаил');
  await search.fill('77011234567');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toContainText('Айгуль');

  await list.getByRole('button').click();
  await expect.poll(() => api.avatarCalls).toEqual([first]);
  await expect(page.locator(`img[src="${avatarUrl}"]`).first()).toBeVisible();
  await expect.poll(() => api.readCalls).toEqual([first]);
  await expect(list.getByLabel('Непрочитанных сообщений: 3')).toHaveCount(0);
  await expect(page).toHaveTitle('Диалог — WhatsApp через GREEN-API');

  await page.reload();
  await page
    .getByRole('navigation', { name: 'Список чатов' })
    .getByRole('button', { name: /Айгуль/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Айгуль' })).toBeVisible();
  await expect.poll(() => api.avatarCalls).toEqual([first, first]);
});

test('shows every chat when the first page fits without scrolling', async ({ page, context }) => {
  const api = await mockApi(context);
  api.recentChats = Array.from({ length: 120 }, (_, index) => ({
    id: `${77020000000 + index}@c.us`,
    name: `Контакт ${index + 1}`,
    type: 'user',
  }));
  await page.setViewportSize({ width: 1280, height: 10000 });

  await connect(page);

  const list = page.getByRole('navigation', { name: 'Список чатов' });
  await expect(list.getByRole('button')).toHaveCount(120);
});

test('a saved session from the previous messenger is discarded', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    sessionStorage.setItem(
      'dialog.connection.v1',
      JSON.stringify({
        config: {
          apiUrl: 'https://api.green-api.com',
          idInstance: '1101728000',
          apiTokenInstance: 'old-token',
        },
        accountId: 'old-account',
      }),
    );
  });
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Начните диалог' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('dialog.connection.v1'))).toBeNull();
});

test('a lid recipient and a phone webhook remain one conversation', async ({ page, context }) => {
  const api = await mockApi(context);
  api.recipientChatId = '120650379300963@lid';
  await connect(page);
  await createChat(page);

  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Привет');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect.poll(() => api.sent[0]?.chatId).toBe(api.recipientChatId);

  api.queue.push(incoming('Ответ', '2002', '77011234567@c.us'));
  await expect(page.getByRole('log').getByText('Ответ')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Список чатов' }).getByRole('button'),
  ).toHaveCount(1);
});

test('late send response preserves new draft and original recipient', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  let release!: () => void;
  api.gate = new Promise((resolve) => {
    release = resolve;
  });

  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });

  await input.fill('Сообщение A');
  await input.press('Enter');
  await expect.poll(() => api.sent.length).toBe(1);

  await input.fill('Черновик B');
  await createChat(page, '+7 701 123-45-68');
  release();
  await page.getByRole('button', { name: /Анна/ }).click();

  await expect(input).toHaveValue('Черновик B');
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();
  expect(api.sent[0]?.chatId).toBe('77011234567@c.us');
});

test('unknown send is never retried without an explicit user action', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  api.failSend = true;

  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Возможно отправлено');
  await page.getByRole('button', { name: 'Отправить сообщение', exact: true }).click();

  await expect(
    page.getByRole('log').getByText('Результат неизвестен', { exact: true }).last(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('может создать дубль');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();

  expect(api.sent).toHaveLength(1);
});

test('tabs share messages and transfer queue ownership after closing the reader @smoke', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);
  const second = await context.newPage();
  await connect(second);
  await createChat(second);

  const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await composer.fill('Черновик первой вкладки');
  const otherComposer = second.getByRole('textbox', { name: 'Сообщение', exact: true });
  await otherComposer.fill('Сообщение второй вкладки');
  await otherComposer.press('Enter');
  await expect(
    page.getByRole('log').getByText('Сообщение второй вкладки', { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue('Черновик первой вкладки');

  api.queue.push(incoming('Входящее в обе вкладки', 'shared-1'));
  await expect(
    page.getByRole('log').getByText('Входящее в обе вкладки', { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole('log').getByText('Входящее в обе вкладки', { exact: true }),
  ).toBeVisible();
  expect(api.ackCalls).toBe(1);

  await page.close();
  api.queue.push(incoming('После закрытия первой', 'shared-2', '77011234567@c.us', 2));
  await expect(
    second.getByRole('log').getByText('После закрытия первой', { exact: true }),
  ).toBeVisible();
  expect(api.ackCalls).toBe(2);

  await second.getByRole('button', { name: 'Выйти', exact: true }).click();
  await second.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(second.getByRole('heading', { name: 'Начните диалог' })).toBeVisible();
});

test('logout purges local data and never calls remote logout @smoke', async ({ page, context }) => {
  await mockApi(context);
  let remoteLogout = false;
  page.on('request', (request) => {
    if (request.url().includes('/logout/')) remoteLogout = true;
  });

  await connect(page);
  await createChat(page);

  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Начните диалог' })).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('dialog.whatsapp.connection.v1')),
  ).toBeNull();

  await connect(page);

  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  await expect(page.getByRole('log').getByRole('article')).toHaveCount(0);
  expect(remoteLogout).toBe(false);
});

test('keeps the current conversation during a connection outage @smoke', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);
  const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await composer.fill('История');
  await composer.press('Enter');
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByRole('log').getByText('История', { exact: true })).toBeVisible();
  await composer.fill('Черновик');
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();

  await context.setOffline(false);
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeEnabled();
  await expect(composer).toHaveValue('Черновик');
  expect(api.sent).toHaveLength(1);
});

test('text entry handles IME, multiline and focus', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });

  await input.fill('Первая');
  await input.press('Shift+Enter');
  await input.pressSequentially('В');

  await expect(input).toHaveValue('Первая\nВ');

  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });

  expect(api.sent).toHaveLength(0);

  await input.press('Enter');

  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(api.sent[0]?.message).toBe('Первая\nВ');
});

test('mobile navigation and modal focus @smoke', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(context);
  await connect(page);
  await createChat(page);

  await expect(page.getByRole('heading', { name: 'Анна' })).toBeFocused();

  await page.getByRole('button', { name: 'К списку чатов' }).click();
  await expect(page.getByRole('heading', { name: /Чаты/ })).toBeFocused();

  const trigger = page.getByRole('button', { name: 'Новый чат', exact: true }).first();

  await trigger.click();
  await page.getByLabel('Номер телефона').press('Escape');

  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('forms and chat remain usable with enlarged base text', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(context);
  await page.goto('/');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '32px';
  });

  await expect(page.getByRole('heading', { name: 'Начните диалог' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByLabel('ID инстанса').fill('1101728000');
  await page.getByLabel('Токен API').fill('e2e-test-token');
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новый чат', exact: true })).toBeVisible();
  await createChat(page);

  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Крупный текст');
  await expect(page.getByRole('button', { name: 'Отправить сообщение' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.setViewportSize({ width: 768, height: 900 });
  const sidebarHeader = page.locator('aside[aria-label="Чаты"] header');
  expect(await sidebarHeader.evaluate((header) => header.scrollWidth <= header.clientWidth)).toBe(
    true,
  );
});

test('closing a pending recipient check does not create a chat', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);

  let release!: () => void;
  api.resolveGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер телефона').fill('+7 701 123-45-67');
  await page.getByLabel('Первое сообщение (опционально)').fill('Не отправлять после отмены');
  await page.getByRole('button', { name: 'Создать и отправить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Проверяем…' })).toBeDisabled();
  await expect.poll(() => api.resolveCalls).toBe(1);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  release();
  await expect.poll(() => api.resolveCompleted).toBe(1);

  await expect(page.getByText('Здесь будут ваши чаты')).toBeVisible();
  await expect(page.getByRole('button', { name: /Анна/ })).toHaveCount(0);
  expect(api.sent).toEqual([]);
});

test('login and conversation meet automated accessibility checks', async ({ page, context }) => {
  const api = await mockApi(context);
  api.recentChats = [{ id: '77021234567@c.us', name: 'Михаил', type: 'user', unreadCount: 3 }];
  await page.goto('/');

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);

  await connect(page);
  await createChat(page);
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Привет');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByRole('img', { name: 'Принято API', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Непрочитанных сообщений: 3' })).toBeVisible();

  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('duplicates and delivery notifications do not block the queue', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  const event = incoming('Один раз');

  api.queue.push(event, { ...event, receiptId: 2 });

  await expect.poll(() => api.ackCalls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('log').getByText('Один раз', { exact: true })).toHaveCount(1);

  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Исходящее');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();

  api.queue.push({
    receiptId: 3,
    body: {
      typeWebhook: 'outgoingMessageStatus',
      instanceData: event.body.instanceData,
      chatId: '77011234567@c.us',
      idMessage: '1001',
      timestamp: Math.floor(Date.now() / 1000),
      status: 'failed',
    },
  });

  await expect.poll(() => api.ackCalls).toBeGreaterThanOrEqual(3);
  await expect(page.getByLabel('Принято API', { exact: true })).toBeVisible();

  api.queue.push({
    receiptId: 4,
    body: {
      typeWebhook: 'outgoingMessageStatus',
      instanceData: event.body.instanceData,
      chatId: '77011234567@c.us',
      timestamp: Math.floor(Date.now() / 1000),
      status: 'noAccount',
    },
  });
  await expect.poll(() => api.ackCalls).toBeGreaterThanOrEqual(4);

  api.queue.push(incoming('Очередь продолжает работать', '5000', '77011234567@c.us', 5));
  await expect(page.getByRole('log').getByText('Очередь продолжает работать')).toBeVisible();
});

test('malformed notification requires confirmation before the queue can continue', async ({
  page,
  context,
}) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  const invalid = incoming('Нельзя прочитать');
  api.queue.push(
    { ...invalid, body: { ...invalid.body, timestamp: -1 } },
    incoming('После пропуска', '2002', '77011234567@c.us', 2),
  );

  await expect(page.getByText(/Уведомление 1 содержит некорректные данные/)).toBeVisible();
  expect(api.ackCalls).toBe(0);

  await page.getByRole('button', { name: 'Пропустить уведомление' }).click();
  await expect(page.getByRole('dialog')).toContainText('не появится в этой переписке');
  await page.getByRole('button', { name: 'Отмена' }).click();
  expect(api.ackCalls).toBe(0);

  await page.getByRole('button', { name: 'Пропустить уведомление' }).click();
  await page.getByRole('button', { name: 'Пропустить и продолжить' }).click();
  await expect(page.getByRole('log').getByText('После пропуска')).toBeVisible();
  expect(api.ackCalls).toBe(2);
});

test('reading old messages does not jump to incoming text', async ({ page, context }) => {
  const api = await mockApi(context);
  await connect(page);
  await createChat(page);

  for (let i = 0; i < 24; i++) {
    api.queue.push(
      incoming(
        `Сообщение ${i}. Длинный текст для проверки прокрутки.\nВторая строка.`,
        String(3000 + i),
        '77011234567@c.us',
        i + 1,
      ),
    );
  }

  await expect.poll(() => api.ackCalls, { timeout: 15_000 }).toBe(24);

  const log = page.getByRole('log');

  await log.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });

  api.queue.push(incoming('Новое внизу', '9000', '77011234567@c.us', 25));

  await expect(page.getByRole('button', { name: 'Новые сообщения' })).toBeVisible();
  expect(await log.evaluate((element) => element.scrollTop)).toBeLessThan(20);
  await page.getByRole('button', { name: 'Новые сообщения' }).click();
  await expect(log.getByText('Новое внизу')).toBeInViewport();
});
