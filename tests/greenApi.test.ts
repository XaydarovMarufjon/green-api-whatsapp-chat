import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GreenApiTransport,
  normalizePhone,
  validateCredentials,
  parseNotification,
} from '../src/lib/greenApi';
const credentials = {
  apiUrl: 'https://3100.api.green-api.com',
  idInstance: '3100000000',
  apiTokenInstance: 'test_token',
};
const response = (data: unknown, status = 200) =>
  new Response(data === undefined ? '' : JSON.stringify(data), { status });
const body = {
  typeWebhook: 'incomingMessageReceived',
  idMessage: '123',
  timestamp: 100,
  senderData: { chatId: '123456789012345@lid', chatName: 'Test' },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Hello' } },
};
afterEach(() => vi.useRealTimers());
describe('validation', () => {
  it('normalizes international phones and rejects invalid input', () => {
    expect(normalizePhone('+7 (999) 123-45-67')).toBe('79991234567');
    expect(normalizePhone('+375 29 123 45 67')).toBe('375291234567');
    expect(normalizePhone('+998 90 123 45 67')).toBe('998901234567');
    expect(normalizePhone('1234567')).toBe('1234567');
    expect(normalizePhone('123456789012345')).toBe('123456789012345');
    for (const input of ['hello79991234567', '0123456789', '1234567890123456', '', '123'])
      expect(() => normalizePhone(input)).toThrow();
  });
  it.each([
    ['https://3100.api.green-api.com', 'https://3100.api.green-api.com'],
    ['https://7107.api.greenapi.com', 'https://7107.api.greenapi.com'],
    ['https://api.green-api.com/', 'https://api.green-api.com'],
    ['https://api.greenapi.com/', 'https://api.greenapi.com'],
  ])('accepts official base URL without rewriting its host: %s', (apiUrl, expected) => {
    expect(validateCredentials({ ...credentials, apiUrl }).apiUrl).toBe(expected);
  });
  it.each([
    'https://api.green-api.com/v3/',
    'https://7107.api.greenapi.com/v3',
    'http://7107.api.greenapi.com',
    'https://evil.com',
    'https://api.green-api.com.evil.com',
    'https://7107.api.greenapi.com.evil.com',
    'https://7107.api.greenap1.com',
    'https://7107.api.greenapi.com@evil.com',
    'https://evil@7107.api.greenapi.com',
    'https://foo.7107.api.greenapi.com',
    'https://custom.api.greenapi.com',
    'https://media.greenapi.com',
    'https://green-api.com/max',
    'https://api.greenapi.com:8443',
    'https://api.greenapi.com/other',
    'https://api.greenapi.com?token=x',
    'https://api.greenapi.com#fragment',
  ])('rejects untrusted or unsupported base URL: %s', (apiUrl) => {
    expect(() => validateCredentials({ ...credentials, apiUrl })).toThrow();
  });
  it('rejects a spoof before fetch is called', () => {
    const fetcher = vi.fn();
    expect(
      () =>
        new GreenApiTransport(
          { ...credentials, apiUrl: 'https://7107.api.greenapi.com.evil.com' },
          fetcher,
        ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the exact no-hyphen cluster with mocked requests', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ stateInstance: 'authorized' }));
    await new GreenApiTransport(
      { ...credentials, apiUrl: 'https://7107.api.greenapi.com' },
      fetcher,
    ).connect(new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://7107.api.greenapi.com/waInstance3100000000/getStateInstance/test_token',
    );
  });
});
describe('REST contract', () => {
  it('checks state, resolves phone and sends text using the returned WhatsApp LID', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({ stateInstance: 'authorized' }))
      .mockResolvedValueOnce(response({ existsWhatsapp: true, chatId: '123456789012345@lid' }))
      .mockResolvedValueOnce(response({ idMessage: 'abc' }));
    const api = new GreenApiTransport(credentials, mock),
      signal = new AbortController().signal;
    await api.connect(signal);
    expect(await api.resolvePhone('+79991234567', signal)).toEqual({
      chatId: '123456789012345@lid',
    });
    expect(await api.send('123456789012345@lid', 'Hello', signal)).toEqual({ idMessage: 'abc' });
    expect(mock.mock.calls[0][0]).toBe(
      `${credentials.apiUrl}/waInstance3100000000/getStateInstance/test_token`,
    );
    expect(mock.mock.calls[0][1].method).toBe('GET');
    expect(JSON.parse(mock.mock.calls[1][1].body)).toEqual({ chatId: '79991234567@c.us' });
    expect(mock.mock.calls[1][1].method).toBe('POST');
    expect(mock.mock.calls[1][0]).toContain('/checkWhatsapp/test_token');
    expect(JSON.parse(mock.mock.calls[2][1].body)).toEqual({
      chatId: '123456789012345@lid',
      message: 'Hello',
    });
    expect(mock.mock.calls[2][1].redirect).toBe('error');
  });
  it('does not retry ambiguous sends and marks errors uncertain', async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError('secret URL'));
    await expect(
      new GreenApiTransport(credentials, mock).send(
        '123456789012345@lid',
        'Hello',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ uncertain: true });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects an unauthorized instance and absent accounts', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({ stateInstance: 'notAuthorized' }))
      .mockResolvedValueOnce(response({ existsWhatsapp: false }));
    const api = new GreenApiTransport(credentials, mock),
      signal = new AbortController().signal;
    await expect(api.connect(signal)).rejects.toThrow('notAuthorized');
    await expect(api.resolvePhone('79991234567', signal)).rejects.toThrow(
      'аккаунт WhatsApp не найден',
    );
  });
});
describe('notification parsing', () => {
  it('parses plain/extended text, timestamps, outgoing echoes and delivery states', () => {
    expect(parseNotification(body)).toMatchObject({
      kind: 'message',
      message: { text: 'Hello', outgoing: false, timestamp: 100000 },
    });
    expect(
      parseNotification({
        ...body,
        typeWebhook: 'outgoingAPIMessageReceived',
        messageData: {
          typeMessage: 'extendedTextMessage',
          extendedTextMessageData: { text: 'URL' },
        },
      }),
    ).toMatchObject({ kind: 'message', message: { text: 'URL', outgoing: true } });
    expect(
      parseNotification({
        typeWebhook: 'outgoingMessageStatus',
        chatId: '123456789012345@lid',
        idMessage: '123',
        status: 'read',
      }),
    ).toEqual({ kind: 'status', chatId: '123456789012345@lid', id: '123', status: 'read' });
    expect(
      parseNotification({
        typeWebhook: 'outgoingMessageStatus',
        chatId: '123456789012345@lid',
        idMessage: '123',
        status: 'noAccount',
      }),
    ).toMatchObject({ status: 'failed' });
    expect(parseNotification({ ...body, messageData: { typeMessage: 'imageMessage' } })).toBeNull();
  });
});
describe('malformed notification defense', () => {
  it('accepts only known own status keys', () => {
    for (const status of ['constructor', '__proto__', 'toString', {}, null]) {
      expect(
        parseNotification({
          typeWebhook: 'outgoingMessageStatus',
          chatId: '123456789012345@lid',
          idMessage: '123',
          status,
        }),
      ).toBeNull();
    }
  });
  it('falls back from malformed names and invalid Date timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'));
    for (const timestamp of [1e100, Infinity, -1e100, '100', null]) {
      expect(
        parseNotification({
          ...body,
          timestamp,
          senderData: {
            chatId: '123456789012345@lid',
            chatName: { bad: true },
            senderName: 'Fallback',
          },
        }),
      ).toMatchObject({ name: 'Fallback', message: { timestamp: Date.now() } });
    }
    expect(
      parseNotification({
        ...body,
        senderData: { chatId: '123456789012345@lid', chatName: 123, senderName: {} },
      }),
    ).toMatchObject({ name: undefined });
  });
});
describe('serial polling', () => {
  it('acknowledges duplicates and unsupported events without rendering twice', async () => {
    const controller = new AbortController(),
      events = vi.fn();
    const queue = [
      { receiptId: 1, body },
      { result: true },
      { receiptId: 2, body },
      { result: true },
      { receiptId: 3, body: { typeWebhook: 'unknown' } },
      { result: true },
    ];
    const mock = vi.fn(async () => {
      const data = queue.shift();
      if (!queue.length) controller.abort();
      return response(data);
    });
    await new GreenApiTransport(credentials, mock).listen(events, vi.fn(), controller.signal);
    expect(events).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls).toHaveLength(6);
    // Inspect REST calls separately because the mock's inferred signature is argument-free.
    const calls = mock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => c[1].method)).toEqual([
      'GET',
      'DELETE',
      'GET',
      'DELETE',
      'GET',
      'DELETE',
    ]);
    expect(calls[1][0]).toContain('/deleteNotification/test_token/1');
  });
  it('retries failed acknowledgements before receiving another event', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      events = vi.fn();
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({ receiptId: 7, body }))
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementationOnce(async () => {
        controller.abort();
        return response({ result: true });
      });
    const promise = new GreenApiTransport(credentials, mock).listen(
      events,
      vi.fn(),
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(1100);
    await promise;
    expect(events).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[1][0]).toBe(mock.mock.calls[2][0]);
    expect(mock.mock.calls[2][1].method).toBe('DELETE');
  });
  it('stops visibly on terminal authorization failure', async () => {
    const state = vi.fn(),
      mock = vi.fn().mockResolvedValue(response({}, 401));
    await new GreenApiTransport(credentials, mock).listen(
      vi.fn(),
      state,
      new AbortController().signal,
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledWith(expect.stringContaining('Доступ запрещён'));
  });
  it('aborts a long poll at timeout and backs off before retrying', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(),
      state = vi.fn();
    let requestSignal: AbortSignal | null | undefined;
    const mock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal;
          requestSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const promise = new GreenApiTransport(credentials, mock).listen(
      vi.fn(),
      state,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(40000);
    expect(requestSignal!.aborted).toBe(true);
    expect(state).toHaveBeenCalledWith('Связь прервана. Повторное подключение…');
    expect(mock).toHaveBeenCalledTimes(1);
    controller.abort();
    await promise;
  });
  it('aborts an outstanding long poll cleanly', async () => {
    const controller = new AbortController();
    const mock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ),
    );
    const promise = new GreenApiTransport(credentials, mock).listen(
      vi.fn(),
      vi.fn(),
      controller.signal,
    );
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsApp compatibility and request safety', () => {
  it.each(['998901234567@c.us', undefined])(
    'supports canonical phone IDs and old check responses: %s',
    async (chatId) => {
      const mock = vi.fn().mockResolvedValue(response({ existsWhatsapp: true, chatId }));
      expect(
        await new GreenApiTransport(credentials, mock).resolvePhone(
          '+998901234567',
          new AbortController().signal,
        ),
      ).toEqual({ chatId: '998901234567@c.us' });
      expect(JSON.parse(mock.mock.calls[0][1].body)).toEqual({ chatId: '998901234567@c.us' });
    },
  );
  it.each(['555', 'garbage@lid', '120363043968066561@g.us', ''])(
    'rejects malformed personal resolution: %s',
    async (chatId) => {
      const mock = vi.fn().mockResolvedValue(response({ existsWhatsapp: true, chatId }));
      await expect(
        new GreenApiTransport(credentials, mock).resolvePhone(
          '+998901234567',
          new AbortController().signal,
        ),
      ).rejects.toThrow('Проверка номера');
    },
  );
  it.each([
    '998901234567@c.us',
    '120650379300963@lid',
    '120363043968066561@g.us',
    '79876543210-1581234048@g.us',
  ])('sends documented WhatsApp ID %s with 20,000 characters', async (chatId) => {
    const mock = vi.fn().mockResolvedValue(response({ idMessage: 'sent' }));
    await expect(
      new GreenApiTransport(credentials, mock).send(
        chatId,
        'a'.repeat(20000),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ idMessage: 'sent' });
  });
  it('rejects invalid targets and text before fetch', async () => {
    const mock = vi.fn(),
      api = new GreenApiTransport(credentials, mock),
      signal = new AbortController().signal;
    for (const chatId of ['555', '-555', 'test@lid', '998901234567@evil', '998901234567@c.us/path'])
      await expect(api.send(chatId, 'hello', signal)).rejects.toThrow('ID чата WhatsApp');
    for (const text of ['', '  ', 'x'.repeat(20001)])
      await expect(api.send('998901234567@c.us', text, signal)).rejects.toThrow('20000');
    expect(mock).not.toHaveBeenCalled();
  });
  it('keeps network errors secret-safe and distinguishes actual timeouts', async () => {
    const api = new GreenApiTransport(
      credentials,
      vi.fn().mockRejectedValue(new TypeError('secret_token_url')),
    );
    await expect(api.connect(new AbortController().signal)).rejects.toThrow('Точная причина');
    await expect(api.connect(new AbortController().signal)).rejects.not.toThrow('secret_token_url');
    vi.useFakeTimers();
    const mock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const result = expect(
      new GreenApiTransport(credentials, mock).send(
        '998901234567@c.us',
        'Hello',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      uncertain: true,
      message: expect.stringContaining('не ответил вовремя'),
    });
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('canonicalizes phone-based message echoes and statuses to the resolved LID', async () => {
    const controller = new AbortController(),
      events = vi.fn();
    const queue = [
      { existsWhatsapp: true, chatId: '120650379300963@lid' },
      { receiptId: 1, body: { ...body, senderData: { chatId: '998901234567@c.us' } } },
      { result: true },
      { receiptId: 2, body: { ...body, senderData: { chatId: '120650379300963@lid' } } },
      { result: true },
      {
        receiptId: 3,
        body: {
          typeWebhook: 'outgoingMessageStatus',
          chatId: '998901234567@c.us',
          idMessage: '123',
          status: 'read',
        },
      },
      { result: true },
    ];
    const mock = vi.fn(async () => {
      const data = queue.shift();
      if (!queue.length) controller.abort();
      return response(data);
    });
    const api = new GreenApiTransport(credentials, mock);
    await api.resolvePhone('+998901234567', controller.signal);
    await api.listen(events, vi.fn(), controller.signal);
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[0][0]).toMatchObject({
      kind: 'message',
      message: { chatId: '120650379300963@lid' },
    });
    expect(events.mock.calls[1][0]).toMatchObject({
      kind: 'status',
      chatId: '120650379300963@lid',
      status: 'read',
    });
  });
});
