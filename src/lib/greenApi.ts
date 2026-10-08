import type { ChatEvent, Credentials, MessageStatus, Transport } from '../types';

export class GreenApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public terminal = false,
    public uncertain = false,
  ) {
    super(message);
    this.name = 'GreenApiError';
  }
}
export function normalizePhone(value: string): string {
  if (!/^[+\d\s().-]+$/.test(value))
    throw new GreenApiError('Введите международный номер с кодом страны, без букв');
  const phone = value.replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(phone))
    throw new GreenApiError(
      'Международный номер должен содержать от 7 до 15 цифр и начинаться с кода страны',
    );
  return phone;
}
export function validateCredentials(input: Credentials): Credentials {
  let url: URL;
  try {
    url = new URL(input.apiUrl.trim());
  } catch {
    throw new GreenApiError('Укажите API URL из кабинета GREEN-API');
  }
  if (/^\/v3(?:\/|$)/.test(url.pathname))
    throw new GreenApiError(
      'Адрес /v3 относится к MAX. Скопируйте apiUrl инстанса WhatsApp без /v3',
    );
  if (
    url.protocol !== 'https:' ||
    !/^(?:\d+\.)?api\.(?:green-api|greenapi)\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new GreenApiError(
      'Скопируйте apiUrl инстанса: HTTPS, api.green-api.com или api.greenapi.com, возможен числовой кластер; без пути /v3',
    );
  }
  const idInstance = input.idInstance.trim(),
    apiTokenInstance = input.apiTokenInstance.trim();
  if (!/^\d+$/.test(idInstance))
    throw new GreenApiError('ID инстанса должен содержать только цифры');
  if (!/^[a-zA-Z0-9_-]+$/.test(apiTokenInstance))
    throw new GreenApiError('Укажите корректный API Token из кабинета');
  return { apiUrl: url.href.replace(/\/$/, ''), idInstance, apiTokenInstance };
}
const abortError = () => new DOMException('Operation cancelled', 'AbortError');
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
const personalChatId = /^(?:[1-9]\d{6,14}@c\.us|[1-9]\d*@lid)$/;
const validChatId = (value: unknown): value is string =>
  typeof value === 'string' &&
  (personalChatId.test(value) || /^[1-9]\d*(?:-\d+)?@g\.us$/.test(value));

type RecordData = Record<string, any>;
export function parseNotification(body: RecordData): ChatEvent | null {
  if (!body || typeof body !== 'object') return null;
  if (body.typeWebhook === 'outgoingMessageStatus') {
    const statuses: Record<string, MessageStatus> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
      noAccount: 'failed',
      notInGroup: 'failed',
    };
    const status =
      typeof body.status === 'string' && Object.hasOwn(statuses, body.status)
        ? statuses[body.status]
        : undefined;
    return status && typeof body.idMessage === 'string' && validChatId(body.chatId)
      ? { kind: 'status', id: body.idMessage, chatId: body.chatId, status }
      : null;
  }
  if (
    !['incomingMessageReceived', 'outgoingMessageReceived', 'outgoingAPIMessageReceived'].includes(
      body.typeWebhook,
    )
  )
    return null;
  const data = body.messageData;
  const text =
    data?.typeMessage === 'textMessage'
      ? data.textMessageData?.textMessage
      : data?.typeMessage === 'extendedTextMessage'
        ? data.extendedTextMessageData?.text
        : undefined;
  if (
    typeof text !== 'string' ||
    !validChatId(body.senderData?.chatId) ||
    typeof body.idMessage !== 'string'
  )
    return null;
  const outgoing = body.typeWebhook !== 'incomingMessageReceived';
  const name = [body.senderData.chatName, body.senderData.senderName].find(
    (value) => typeof value === 'string' && value.length > 0,
  );
  const milliseconds = typeof body.timestamp === 'number' ? body.timestamp * 1000 : NaN;
  const timestamp =
    Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : Date.now();
  return {
    kind: 'message',
    name,
    message: {
      id: body.idMessage,
      chatId: body.senderData.chatId,
      text,
      timestamp,
      outgoing,
      ...(outgoing ? { status: 'sent' as const } : {}),
    },
  };
}

export class GreenApiTransport implements Transport {
  private credentials: Credentials;
  private listening = false;
  private seen = new Set<string>();
  // CheckWhatsapp can return @lid while webhooks still use phone@c.us.
  private chatAliases = new Map<string, string>();
  constructor(
    credentials: Credentials,
    private fetcher: typeof fetch = fetch,
  ) {
    this.credentials = validateCredentials(credentials);
  }
  private async request(
    method: string,
    verb: string,
    signal: AbortSignal,
    body?: unknown,
    suffix = '',
    timeout = 20000,
  ): Promise<any> {
    if (signal.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const { apiUrl, idInstance, apiTokenInstance } = this.credentials;
    try {
      const response = await this.fetcher(
        `${apiUrl}/waInstance${idInstance}/${method}/${apiTokenInstance}${suffix}`,
        {
          method: verb,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        },
      );
      if (!response.ok) {
        const terminal = [400, 401, 403, 404, 410].includes(response.status);
        // Never expose raw response text or request URLs: either may contain credentials.
        throw new GreenApiError(
          response.status === 401 || response.status === 403
            ? 'Доступ запрещён. Проверьте токен и авторизацию инстанса'
            : response.status === 400
              ? method === 'receiveNotification'
                ? 'Запрос уведомлений отклонён. Проверьте настройки: Webhook URL должен быть пустым'
                : 'Запрос отклонён. Проверьте номер, параметры и настройки инстанса WhatsApp'
              : `Ошибка GREEN-API: HTTP ${response.status}`,
          response.status,
          terminal,
          method === 'sendMessage' && response.status >= 500,
        );
      }
      const text = await response.text();
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new GreenApiError(
          'GREEN-API вернул некорректный ответ',
          0,
          false,
          method === 'sendMessage',
        );
      }
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof GreenApiError) throw error;
      throw new GreenApiError(
        timedOut
          ? 'GREEN-API не ответил вовремя. Проверьте соединение и доступность инстанса'
          : 'Браузер не получил ответ GREEN-API. Проверьте интернет и apiUrl; возможны ограничения сети, расширений или CORS. Точная причина по этой ошибке неизвестна',
        0,
        false,
        method === 'sendMessage',
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  async connect(signal: AbortSignal): Promise<void> {
    const data = await this.request('getStateInstance', 'GET', signal);
    if (data?.stateInstance !== 'authorized')
      throw new GreenApiError(
        `Состояние инстанса: ${typeof data?.stateInstance === 'string' && /^[a-zA-Z]+$/.test(data.stateInstance) ? data.stateInstance : 'unavailable'}. Авторизуйте его в кабинете GREEN-API`,
        0,
        true,
      );
  }
  async resolvePhone(phone: string, signal: AbortSignal): Promise<{ chatId: string }> {
    const normalized = normalizePhone(phone);
    const data = await this.request('checkWhatsapp', 'POST', signal, {
      chatId: `${normalized}@c.us`,
    });
    if (data?.existsWhatsapp === true) {
      // Legacy responses omit chatId; never silently ignore a malformed returned ID.
      const chatId = data.chatId == null ? `${normalized}@c.us` : data.chatId;
      if (typeof chatId === 'string' && personalChatId.test(chatId)) {
        this.chatAliases.set(`${normalized}@c.us`, chatId);
        return { chatId };
      }
    }
    throw new GreenApiError(
      data?.existsWhatsapp === false
        ? 'Для этого номера аккаунт WhatsApp не найден'
        : 'Проверка номера недоступна. Проверьте авторизацию или повторите позже',
    );
  }
  async send(chatId: string, message: string, signal: AbortSignal): Promise<{ idMessage: string }> {
    if (!validChatId(chatId)) throw new GreenApiError('Некорректный ID чата WhatsApp');
    if (!message.trim() || message.length > 20000)
      throw new GreenApiError('Сообщение должно содержать от 1 до 20000 символов');
    const data = await this.request('sendMessage', 'POST', signal, { chatId, message });
    if (typeof data?.idMessage !== 'string')
      throw new GreenApiError(
        'Ответ об отправке неполный. Проверьте чат перед повторной отправкой',
        0,
        false,
        true,
      );
    return { idMessage: data.idMessage };
  }
  async listen(
    onEvent: (event: ChatEvent) => void,
    onState: (state: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.listening) throw new GreenApiError('Получение уведомлений уже запущено');
    this.listening = true;
    let pending: number | null = null,
      failures = 0,
      stopAfterAck = false;
    try {
      while (!signal.aborted) {
        try {
          if (pending !== null) {
            const deleted = await this.request(
              'deleteNotification',
              'DELETE',
              signal,
              undefined,
              `/${pending}`,
            );
            if (typeof deleted?.result !== 'boolean')
              throw new GreenApiError('Неполный ответ на подтверждение уведомления');
            // false also means this receipt was already acknowledged by a prior request.
            pending = null;
            if (stopAfterAck) {
              onState('Инстанс не готов. Проверьте авторизацию в кабинете и подключитесь снова');
              return;
            }
            failures = 0;
            onState('Подключено');
            continue;
          }
          const notification = await this.request(
            'receiveNotification',
            'GET',
            signal,
            undefined,
            '?receiveTimeout=30',
            40000,
          );
          if (!notification) {
            failures = 0;
            onState('Подключено');
            continue;
          }
          if (!Number.isSafeInteger(notification.receiptId))
            throw new GreenApiError('Некорректный идентификатор уведомления');
          const event = parseNotification(notification.body);
          if (event) {
            if (event.kind === 'message')
              event.message.chatId =
                this.chatAliases.get(event.message.chatId) ?? event.message.chatId;
            else event.chatId = this.chatAliases.get(event.chatId) ?? event.chatId;
            const key =
              event.kind === 'message'
                ? `message:${event.message.chatId}:${event.message.id}`
                : `status:${event.chatId}:${event.id}:${event.status}`;
            if (!this.seen.has(key)) {
              onEvent(event);
              this.seen.add(key);
              if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
            }
          }
          pending = notification.receiptId;
          stopAfterAck =
            notification.body?.typeWebhook === 'stateInstanceChanged' &&
            notification.body.stateInstance !== 'authorized';
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof GreenApiError && error.terminal) {
            onState(error.message);
            return;
          }
          onState('Связь прервана. Повторное подключение…');
          await delay(Math.min(1000 * 2 ** failures++, 30000), signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.listening = false;
    }
  }
}
