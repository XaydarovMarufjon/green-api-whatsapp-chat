import { test, expect } from '@playwright/test';
test('demo: send, simulated reply, chat isolation, validation and logout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Подключите свой инстанс' })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть демо без аккаунта' }).click();
  await expect(page.getByRole('heading', { name: 'Демо-собеседник' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Сообщение', exact: true })
    .fill('Привет! Проверка демо.');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByText('Привет! Проверка демо.', { exact: true })).toHaveCount(1);
  await expect(
    page.getByText('Привет! Это демо-ответ. Сообщения остаются только в этой сессии браузера.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByTitle('Прочитано')).toBeVisible();
  await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
  await page.getByLabel('Номер получателя').fill('invalid');
  await page.getByRole('button', { name: 'Создать чат' }).click();
  await expect(page.getByRole('alert')).toContainText('номер');
  await page.getByLabel('Номер получателя').fill('+7 999 111-22-33');
  await page.getByRole('button', { name: 'Создать чат' }).click();
  await expect(page.getByRole('heading', { name: '+79991112233', exact: true })).toBeVisible();
  await expect(page.getByText('Привет! Проверка демо.', { exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Черновик');
  await page.getByRole('button', { name: /Демо-собеседник/ }).click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue('');
  await page.getByRole('button', { name: /\+79991112233/ }).click();
  await expect(page.getByRole('textbox', { name: 'Сообщение', exact: true })).toHaveValue(
    'Черновик',
  );
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await expect(page.getByRole('heading', { name: 'Подключите свой инстанс' })).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(errors).toEqual([]);
});
test('mobile: back, cancel, logout and reconnect work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть демо без аккаунта' }).click();
  await expect(page.getByRole('heading', { name: 'Демо-собеседник' })).toBeVisible();
  await page.getByRole('button', { name: 'Назад к чатам' }).click();
  await page.getByRole('button', { name: 'Новый чат', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByLabel('Номер получателя')).toHaveCount(0);
  await page.getByRole('button', { name: 'Отключиться' }).click();
  await page.getByRole('button', { name: 'Открыть демо без аккаунта' }).click();
  await expect(page.getByRole('heading', { name: 'Демо-собеседник' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('live adapter through browser mocks: connect, lookup, send and incoming reply', async ({
  page,
}) => {
  let sent = false;
  let delivered = false;
  const calls: string[] = [];
  await page.route('https://3100.api.green-api.com/**', async (route) => {
    const url = route.request().url();
    calls.push(url.split('/')[4]);
    let body: unknown = {};
    if (url.includes('getStateInstance')) body = { stateInstance: 'authorized' };
    else if (url.includes('checkWhatsapp'))
      body = { existsWhatsapp: true, chatId: '123456789012345@lid' };
    else if (url.includes('sendMessage')) {
      sent = true;
      body = { idMessage: 'out-1' };
      expect(route.request().postDataJSON()).toEqual({
        chatId: '123456789012345@lid',
        message: 'Mock live test',
      });
    } else if (url.includes('receiveNotification')) {
      await new Promise((r) => setTimeout(r, 100));
      if (sent && !delivered) {
        delivered = true;
        body = {
          receiptId: 11,
          body: {
            typeWebhook: 'incomingMessageReceived',
            idMessage: 'in-1',
            timestamp: 1700000000,
            senderData: { chatId: '123456789012345@lid', senderName: 'Test' },
            messageData: {
              typeMessage: 'textMessage',
              textMessageData: { textMessage: 'Mock API reply' },
            },
          },
        };
      } else body = null;
    } else if (url.includes('deleteNotification')) {
      expect(route.request().method()).toBe('DELETE');
      body = { result: true };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto('/');
  await page.getByLabel('API URL', { exact: true }).fill('https://3100.api.green-api.com');
  await page.getByLabel('idInstance', { exact: true }).fill('123');
  await page.getByLabel('apiTokenInstance', { exact: true }).fill('test-token');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.getByRole('button', { name: 'Новый чат', exact: true }).first().click();
  await page.getByLabel('Номер получателя').fill('+79991234567');
  await page.getByRole('button', { name: 'Создать чат' }).click();
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Mock live test');
  await page.getByRole('button', { name: 'Отправить сообщение' }).click();
  await expect(page.getByText('Mock API reply', { exact: true })).toBeVisible();
  await expect.poll(() => calls.includes('deleteNotification')).toBe(true);
});
