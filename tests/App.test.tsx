import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { DemoTransport } from '../src/lib/demo';

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
async function openDemo() {
  fireEvent.click(screen.getByRole('button', { name: 'Открыть демо без аккаунта' }));
  await advance(500);
  expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeInTheDocument();
}
function compose(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение' }), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
}
function logout() {
  fireEvent.click(screen.getByRole('button', { name: 'Отключиться' }));
}
function mount() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App session lifecycle', () => {
  it('connects, sends and receives once under StrictMode without network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const view = mount();
    await openDemo();
    compose('StrictMode hello');
    await advance(2000);
    const log = screen.getByRole('log');
    expect(within(log).getAllByText('StrictMode hello')).toHaveLength(1);
    expect(within(log).getByText('Прочитано')).toBeInTheDocument();
    expect(log.querySelectorAll('.message-row')).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    view.unmount();
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can disconnect while the initial demo contact is resolving and reconnect cleanly', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть демо без аккаунта' }));
    await advance(260);
    logout();
    await advance(1000);
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    await openDemo();
    expect(screen.getByRole('log').querySelectorAll('.message-row')).toHaveLength(0);
    compose('New session');
    await advance(2000);
    expect(screen.getByRole('log').querySelectorAll('.message-row')).toHaveLength(2);
  });

  it('ignores a late send result after logout and permits new-session sends', async () => {
    mount();
    await openDemo();
    let complete!: (result: { idMessage: string }) => void;
    vi.spyOn(DemoTransport.prototype, 'send').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    compose('Old pending send');
    logout();
    await openDemo();
    compose('Fresh send');
    await act(async () => {
      complete({ idMessage: 'stale-server-id' });
    });
    await advance(2000);
    const log = screen.getByRole('log');
    expect(within(log).queryByText('Old pending send')).not.toBeInTheDocument();
    expect(within(log).getByText('Fresh send')).toBeInTheDocument();
    expect(log.querySelectorAll('.message-row')).toHaveLength(2);
    expect(within(log).getByText('Прочитано')).toBeInTheDocument();
  });

  it('ignores an old phone lookup after logout without clearing the new session', async () => {
    mount();
    await openDemo();
    let complete!: (result: { chatId: string }) => void;
    vi.spyOn(DemoTransport.prototype, 'resolvePhone').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Новый чат' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Номер получателя' }), {
      target: { value: '+79991234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать чат' }));
    logout();
    await openDemo();
    await act(async () => {
      complete({ chatId: 'stale-chat' });
    });
    expect(screen.queryByText('+79991234567')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Демо-собеседник' })).toBeInTheDocument();
  });
});

describe('WhatsApp app with mocked HTTP', () => {
  it('connects, creates an Uzbekistan-number chat, sends and receives in the same LID chat', async () => {
    let hasSent = false;
    let replied = false;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (url.includes('/getStateInstance/')) return json({ stateInstance: 'authorized' });
      if (url.includes('/checkWhatsapp/')) {
        expect(JSON.parse(String(init?.body))).toEqual({ chatId: '998901234567@c.us' });
        return json({ existsWhatsapp: true, chatId: '123456789012345@lid' });
      }
      if (url.includes('/sendMessage/')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          chatId: '123456789012345@lid',
          message: 'WhatsApp test',
        });
        hasSent = true;
        return json({ idMessage: 'wa-out-1' });
      }
      if (url.includes('/deleteNotification/')) return json({ result: true });
      if (url.includes('/receiveNotification/')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (hasSent && !replied) {
          replied = true;
          return json({
            receiptId: 21,
            body: {
              typeWebhook: 'incomingMessageReceived',
              idMessage: 'wa-in-1',
              timestamp: Date.now() / 1000,
              senderData: { chatId: '998901234567@c.us', senderName: 'Test recipient' },
              messageData: {
                typeMessage: 'textMessage',
                textMessageData: { textMessage: 'WhatsApp mocked reply' },
              },
            },
          });
        }
        return json(null);
      }
      throw new Error('Unexpected mocked request');
    });
    const view = mount();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('API URL'), {
      target: { value: 'https://7107.api.greenapi.com' },
    });
    fireEvent.change(screen.getByLabelText('idInstance'), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText('apiTokenInstance'), {
      target: { value: 'test_token' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
    await advance(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Новый чат' })[0]);
    fireEvent.change(screen.getByLabelText('Номер получателя'), {
      target: { value: '+998 90 123 45 67' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Создать чат' }));
    await advance(0);
    compose('WhatsApp test');
    await advance(250);
    const log = screen.getByRole('log');
    expect(within(log).getByText('WhatsApp test')).toBeInTheDocument();
    expect(within(log).getByText('WhatsApp mocked reply')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '+998901234567' })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/deleteNotification/'))).toBe(
      true,
    );
    expect(screen.queryByText('test_token')).not.toBeInTheDocument();
    view.unmount();
    await advance(100);
  });
});
