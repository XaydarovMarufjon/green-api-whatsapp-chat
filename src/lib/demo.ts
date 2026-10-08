import type { ChatEvent, Transport } from '../types';

function abortError() {
  return new DOMException('Operation cancelled', 'AbortError');
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Entirely local simulation: no API calls, credentials, or persistent storage. */
export class DemoTransport implements Transport {
  private sequence = 0;
  private listening = false;
  private events: Array<{ at: number; event: ChatEvent }> = [];

  async connect(signal: AbortSignal): Promise<void> {
    await delay(250, signal);
  }

  async resolvePhone(phone: string, signal: AbortSignal): Promise<{ chatId: string }> {
    await delay(180, signal);
    const digits = phone.replace(/[+\s()-]/g, '');
    if (!/^\d{7,15}$/.test(digits))
      throw new Error('Enter a phone number with 7–15 digits, including country code.');
    return { chatId: `${digits}@c.us` };
  }

  async send(chatId: string, message: string, signal: AbortSignal): Promise<{ idMessage: string }> {
    if (!message.trim()) throw new Error('Message cannot be empty.');
    await delay(250, signal);
    const idMessage = `demo-out-${++this.sequence}`;
    const now = Date.now();
    this.events.push(
      { at: now + 200, event: { kind: 'status', id: idMessage, chatId, status: 'sent' } },
      { at: now + 600, event: { kind: 'status', id: idMessage, chatId, status: 'delivered' } },
      { at: now + 1100, event: { kind: 'status', id: idMessage, chatId, status: 'read' } },
      {
        at: now + 1400,
        event: {
          kind: 'message',
          name: 'Демо-собеседник',
          message: {
            id: `demo-in-${this.sequence}`,
            chatId,
            outgoing: false,
            text: 'Привет! Это демо-ответ. Сообщения остаются только в этой сессии браузера.',
            timestamp: now + 1400,
          },
        },
      },
    );
    this.events.sort((a, b) => a.at - b.at);
    return { idMessage };
  }

  async listen(
    onEvent: (event: ChatEvent) => void,
    onState: (state: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    if (this.listening) throw new Error('A demo listener is already running.');
    this.listening = true;
    try {
      onState('Демонстрационный режим');
      while (!signal.aborted) {
        while (!signal.aborted && this.events.length && this.events[0].at <= Date.now()) {
          onEvent(this.events.shift()!.event);
        }
        await delay(100, signal);
      }
    } catch (error) {
      if (!(signal.aborted && error instanceof DOMException && error.name === 'AbortError'))
        throw error;
    } finally {
      this.listening = false;
    }
  }
}
