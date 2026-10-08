import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { Credentials, MessageStatus, Transport } from './types';
import { GreenApiTransport, normalizePhone, validateCredentials } from './lib/greenApi';
import { DemoTransport } from './lib/demo';
import { chatReducer, initialChatState } from './lib/chatState';

const statusLabels: Record<MessageStatus, string> = {
  sending: 'Отправляется',
  queued: 'В очереди',
  sent: 'Отправлено',
  delivered: 'Доставлено',
  read: 'Прочитано',
  failed: 'Не отправлено',
  uncertain: 'Результат неизвестен',
};
const time = (value: number) =>
  new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(value);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось выполнить запрос';
function Icon({ name }: { name: 'send' | 'chat' | 'plus' | 'exit' | 'back' }) {
  const paths = {
    send: 'm4 4 16 8-16 8 3-8-3-8Zm3 8h13',
    chat: 'M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z',
    plus: 'M12 5v14M5 12h14',
    exit: 'M9 4H4v16h5M13 8l4 4-4 4M8 12h12',
    back: 'm14 5-7 7 7 7',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="chat" />
      </span>
      <span>
        WhatsApp<span className="brand-divider"> / </span>
        <small>GREEN-API</small>
      </span>
    </div>
  );
}
export default function App() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [demo, setDemo] = useState(false);
  const [credentials, setCredentials] = useState<Credentials>({
    apiUrl: '',
    idInstance: '',
    apiTokenInstance: '',
  });
  const [accepted, setAccepted] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('Подключение…');
  const [phone, setPhone] = useState('');
  const [newChat, setNewChat] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const session = useRef(new AbortController());
  const busyConnect = useRef(false);
  const busySend = useRef(false);
  const busyCreate = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const active = state.chats.find((c) => c.id === state.activeId);
  const visible = state.messages.filter((m) => m.chatId === state.activeId);
  const draft = state.activeId ? (drafts[state.activeId] ?? '') : '';
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [visible.length, state.activeId]);
  useEffect(() => {
    if (!transport) return;
    const controller = session.current;
    void transport
      .listen(
        (event) => {
          if (!controller.signal.aborted) dispatch({ type: 'event', event });
        },
        (value) => {
          if (!controller.signal.aborted) setConnection(value);
        },
        controller.signal,
      )
      .catch((e) => {
        if (!controller.signal.aborted) setConnection(errorText(e));
      });
    return () => controller.abort();
  }, [transport]);
  useEffect(() => () => session.current.abort(), []);
  async function connect(isDemo: boolean) {
    if (busyConnect.current) return;
    busyConnect.current = true;
    setConnecting(true);
    setError('');
    session.current.abort();
    const controller = new AbortController();
    session.current = controller;
    try {
      const client = isDemo
        ? new DemoTransport()
        : new GreenApiTransport(validateCredentials(credentials));
      await client.connect(controller.signal);
      if (controller.signal.aborted) return;
      setDemo(isDemo);
      setTransport(client);
      setConnection(isDemo ? 'Демонстрационный режим' : 'Подключено');
      setCredentials({ apiUrl: '', idInstance: '', apiTokenInstance: '' });
      setAccepted(false);
      if (isDemo) {
        const { chatId } = await client.resolvePhone('79990000000', controller.signal);
        if (!controller.signal.aborted) {
          dispatch({
            type: 'addChat',
            chat: { id: chatId, name: 'Демо-собеседник', phone: '79990000000', unread: 0 },
          });
          dispatch({ type: 'select', id: chatId });
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      busyConnect.current = false;
      setConnecting(false);
    }
  }
  function logout() {
    session.current.abort();
    setTransport(null);
    dispatch({ type: 'reset' });
    setDrafts({});
    setError('');
    setPhone('');
    setNewChat(false);
    setDemo(false);
    setSending(false);
    setCreating(false);
    busySend.current = false;
    busyCreate.current = false;
  }
  async function createChat(e: FormEvent) {
    e.preventDefault();
    if (!transport || busyCreate.current) return;
    busyCreate.current = true;
    setCreating(true);
    setError('');
    const controller = session.current;
    try {
      const normalized = normalizePhone(phone);
      const { chatId } = await transport.resolvePhone(normalized, controller.signal);
      if (controller.signal.aborted) return;
      dispatch({
        type: 'addChat',
        chat: { id: chatId, name: '+' + normalized, phone: normalized, unread: 0 },
      });
      dispatch({ type: 'select', id: chatId });
      setNewChat(false);
      setPhone('');
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      if (!controller.signal.aborted) {
        setCreating(false);
        busyCreate.current = false;
      }
    }
  }
  async function send() {
    const text = draft.trim();
    if (!transport || !active || busySend.current || !text || text.length > 20000) return;
    const chatId = active.id;
    const localId = crypto.randomUUID();
    const controller = session.current;
    busySend.current = true;
    setSending(true);
    setError('');
    setDrafts((d) => ({ ...d, [chatId]: '' }));
    dispatch({
      type: 'optimistic',
      message: {
        id: localId,
        chatId,
        text,
        timestamp: Date.now(),
        outgoing: true,
        status: 'sending',
      },
    });
    try {
      const { idMessage } = await transport.send(chatId, text, controller.signal);
      if (!controller.signal.aborted) dispatch({ type: 'sent', localId, idMessage });
    } catch (e) {
      if (!controller.signal.aborted) {
        const uncertain = !(
          typeof e === 'object' &&
          e !== null &&
          'uncertain' in e &&
          e.uncertain === false
        );
        dispatch({ type: 'failed', localId, uncertain });
        setError(
          uncertain
            ? 'Результат отправки неизвестен. Проверьте WhatsApp перед повторной отправкой.'
            : errorText(e),
        );
      }
    } finally {
      if (!controller.signal.aborted) {
        busySend.current = false;
        setSending(false);
      }
    }
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }
  if (!transport)
    return (
      <main className="entry">
        <header>
          <Brand />
        </header>
        <div className="entry-content">
          <section className="login-card">
            <div className="card-kicker">GREEN-API / WhatsApp</div>
            <h2>Подключите свой инстанс</h2>
            <p className="muted">
              Инстанс WhatsApp должен быть авторизован через QR-код в кабинете GREEN-API
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connect(false);
              }}
            >
              <label>
                API URL
                <input
                  type="url"
                  autoComplete="off"
                  placeholder="https://7107.api.greenapi.com"
                  required
                  value={credentials.apiUrl}
                  onChange={(e) => setCredentials({ ...credentials, apiUrl: e.target.value })}
                />
              </label>
              <div className="field-hint">
                Скопируйте apiUrl WhatsApp-инстанса из кабинета, сохранив домен без изменений
              </div>
              <label>
                idInstance
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  placeholder="ID инстанса"
                  required
                  value={credentials.idInstance}
                  onChange={(e) => setCredentials({ ...credentials, idInstance: e.target.value })}
                />
              </label>
              <label>
                apiTokenInstance
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="Токен доступа"
                  required
                  value={credentials.apiTokenInstance}
                  onChange={(e) =>
                    setCredentials({ ...credentials, apiTokenInstance: e.target.value })
                  }
                />
              </label>
              <label className="consent">
                <input
                  type="checkbox"
                  required
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />
                <span>
                  Использую тестовый инстанс. Разрешаю получать и подтверждать уведомления:
                  обработанные события удаляются из очереди GREEN-API.
                </span>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary wide" disabled={connecting || !accepted}>
                {connecting ? 'Подключение…' : 'Подключиться'}
                <span aria-hidden="true">→</span>
              </button>
            </form>
            <div className="separator">
              <span>или сначала посмотрите</span>
            </div>
            <button
              className="secondary wide"
              disabled={connecting}
              onClick={() => void connect(true)}
            >
              Открыть демо без аккаунта
            </button>
            <p className="micro">Демо без сети. Токен и чаты хранятся только в памяти до выхода.</p>
          </section>
        </div>
      </main>
    );
  return (
    <main className={`workspace ${active ? 'has-active' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <Brand />
          <button
            className="icon-button"
            title="Отключиться"
            aria-label="Отключиться"
            onClick={logout}
          >
            <Icon name="exit" />
          </button>
        </div>
        <div className="sidebar-title">
          <h1>Сообщения</h1>
          <button
            className="new-button"
            onClick={() => {
              setError('');
              setNewChat((v) => !v);
            }}
            aria-expanded={newChat}
          >
            <Icon name="plus" />
            Новый чат
          </button>
        </div>
        {newChat && (
          <form className="new-chat" onSubmit={createChat}>
            <label>
              Номер получателя
              <input
                autoFocus
                type="tel"
                placeholder="+998 90 123 45 67"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </label>
            <p className="field-hint">Международный номер, например +998 90 123 45 67</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                onClick={() => {
                  setNewChat(false);
                  setPhone('');
                  setError('');
                }}
                disabled={creating}
              >
                Отмена
              </button>
              <button className="primary" disabled={creating}>
                {creating ? 'Поиск…' : 'Создать чат'}
              </button>
            </div>
          </form>
        )}
        <nav className="chat-list" aria-label="Чаты">
          {state.chats.map((chat) => {
            const messages = state.messages.filter((m) => m.chatId === chat.id);
            const last = messages.at(-1);
            return (
              <button
                className={`chat-item ${chat.id === active?.id ? 'selected' : ''}`}
                key={chat.id}
                onClick={() => dispatch({ type: 'select', id: chat.id })}
              >
                <span className="avatar">
                  {chat.name.startsWith('+') ? chat.name.slice(-2) : chat.name.slice(0, 1)}
                </span>
                <span className="chat-copy">
                  <strong>{chat.name}</strong>
                  <span>
                    {last ? (last.outgoing ? 'Вы: ' : '') + last.text : 'Начните разговор'}
                  </span>
                </span>
                <span className="chat-meta">
                  {last && <time>{time(last.timestamp)}</time>}
                  {chat.unread > 0 && <b>{chat.unread}</b>}
                </span>
              </button>
            );
          })}
          {state.chats.length === 0 && (
            <p className="list-empty">Создайте чат по номеру телефона</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="connection-dot" />
          <div>
            <strong>{demo ? 'Демо · без отправки в WhatsApp' : 'GREEN-API · WhatsApp'}</strong>
            <span role="status">{connection}</span>
          </div>
        </div>
      </aside>
      <section className="conversation" aria-label="Переписка">
        {active ? (
          <>
            <header className="conversation-head">
              <button
                className="icon-button mobile-back"
                aria-label="Назад к чатам"
                onClick={() => dispatch({ type: 'select', id: null })}
              >
                <Icon name="back" />
              </button>
              <span className="avatar small">
                {active.name.startsWith('+') ? active.name.slice(-2) : active.name.slice(0, 1)}
              </span>
              <div>
                <h2>{active.name}</h2>
                <p>{demo ? 'Демонстрационный собеседник' : 'Текстовые сообщения · WhatsApp'}</p>
              </div>
              <span className="chat-tag">{demo ? 'DEMO' : 'WhatsApp'}</span>
            </header>
            {demo && (
              <div className="demo-banner">
                Демо-режим: ответы созданы приложением, сообщения не уходят в WhatsApp
              </div>
            )}
            <div className="messages" role="log" aria-label="Сообщения в чате" aria-live="polite">
              <div className="date-chip">
                {new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(
                  new Date(),
                )}
              </div>
              {visible.length === 0 && (
                <div className="empty-chat">
                  <span className="empty-icon">
                    <Icon name="chat" />
                  </span>
                  <h2>Начните с «Привет»</h2>
                  <p>
                    {demo
                      ? 'Напишите сообщение, чтобы проверить демо-ответ'
                      : 'Первое сообщение начнёт ваш разговор'}
                  </p>
                </div>
              )}
              {visible.map((message) => (
                <div
                  className={`message-row ${message.outgoing ? 'outgoing' : ''}`}
                  key={message.id}
                >
                  <div
                    className={`bubble ${message.status === 'failed' || message.status === 'uncertain' ? 'problem' : ''}`}
                  >
                    <p>{message.text}</p>
                    <div className="message-meta">
                      <time>{time(message.timestamp)}</time>
                      {message.outgoing && (
                        <span title={statusLabels[message.status ?? 'queued']}>
                          {statusLabels[message.status ?? 'queued']}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            {error && !newChat && (
              <div className="error chat-error" role="alert">
                {error}
                <button aria-label="Закрыть ошибку" onClick={() => setError('')}>
                  ×
                </button>
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="composer-box">
                <textarea
                  aria-label="Сообщение"
                  placeholder="Напишите сообщение…"
                  rows={1}
                  value={draft}
                  maxLength={20000}
                  onChange={(e) => setDrafts((d) => ({ ...d, [active.id]: e.target.value }))}
                  onKeyDown={onKey}
                />
                <button
                  className="send-button"
                  aria-label="Отправить сообщение"
                  disabled={!draft.trim() || sending}
                  type="submit"
                >
                  <Icon name="send" />
                </button>
              </div>
              <div className="composer-help">
                <span>Enter — отправить · Shift + Enter — новая строка</span>
                <span>{draft.length} / 20000</span>
              </div>
            </form>
          </>
        ) : (
          <div className="no-chat">
            <span className="empty-icon">
              <Icon name="chat" />
            </span>
            <h2>Ваши разговоры здесь</h2>
            <p>Выберите чат или создайте новый по номеру телефона</p>
            <button className="primary" onClick={() => setNewChat(true)}>
              Новый чат
            </button>
            {error && !newChat && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
