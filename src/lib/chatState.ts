import type { Chat, ChatEvent, Message, MessageStatus } from '../types';

export type ChatState = {
  chats: Chat[];
  messages: Message[];
  activeId: string | null;
  /** Status webhooks may arrive before send returns the server message ID. */
  pendingStatuses?: Record<string, MessageStatus>;
};

export type ChatAction =
  | { type: 'addChat'; chat: Chat }
  | { type: 'select'; id: string | null }
  | { type: 'event'; event: ChatEvent }
  | { type: 'optimistic'; message: Message }
  | { type: 'sent'; localId: string; idMessage: string }
  | { type: 'failed'; localId: string; uncertain: boolean }
  | { type: 'reset' };

export const initialChatState: ChatState = { chats: [], messages: [], activeId: null };
const statusRank: Record<MessageStatus, number> = {
  sending: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: -1,
  uncertain: -1,
};
const key = (chatId: string, id: string) => JSON.stringify([chatId, id]);

function mergeStatus(previous?: MessageStatus, next?: MessageStatus): MessageStatus | undefined {
  if (!next) return previous;
  if (!previous) return next;
  // A confirmed delivery cannot become a local failure when a request races a webhook.
  if (next === 'failed' || next === 'uncertain') {
    return statusRank[previous] >= statusRank.delivered ? previous : next;
  }
  return statusRank[next] >= statusRank[previous] ? next : previous;
}

function receiveMessage(state: ChatState, message: Message, name?: string): ChatState {
  const existingIndex = state.messages.findIndex(
    (m) => m.id === message.id && m.chatId === message.chatId,
  );
  const cachedKey = key(message.chatId, message.id);
  const pendingStatuses = { ...state.pendingStatuses };
  const status = mergeStatus(
    mergeStatus(state.messages[existingIndex]?.status, message.status),
    pendingStatuses[cachedKey],
  );
  delete pendingStatuses[cachedKey];
  const nextMessage = { ...state.messages[existingIndex], ...message, status };
  const messages =
    existingIndex === -1
      ? [...state.messages, nextMessage]
      : state.messages.map((m, index) => (index === existingIndex ? nextMessage : m));
  const incomingUnread =
    existingIndex === -1 && !message.outgoing && state.activeId !== message.chatId ? 1 : 0;
  const known = state.chats.some((chat) => chat.id === message.chatId);
  const chats = known
    ? state.chats.map((chat) =>
        chat.id === message.chatId && incomingUnread
          ? { ...chat, unread: chat.unread + incomingUnread }
          : chat,
      )
    : [
        ...state.chats,
        { id: message.chatId, name: name || message.chatId, unread: incomingUnread },
      ];
  return { ...state, chats, messages, pendingStatuses };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return { chats: [], messages: [], activeId: null };
    case 'addChat':
      return state.chats.some((chat) => chat.id === action.chat.id)
        ? state
        : { ...state, chats: [...state.chats, { ...action.chat }] };
    case 'select':
      return {
        ...state,
        activeId: action.id,
        chats: state.chats.map((chat) =>
          chat.id === action.id && chat.unread ? { ...chat, unread: 0 } : chat,
        ),
      };
    case 'optimistic':
      return receiveMessage(state, action.message);
    case 'event': {
      if (action.event.kind === 'message')
        return receiveMessage(state, action.event.message, action.event.name);
      const event = action.event;
      const exists = state.messages.some((m) => m.id === event.id && m.chatId === event.chatId);
      if (exists)
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.id === event.id && m.chatId === event.chatId
              ? { ...m, status: mergeStatus(m.status, event.status) }
              : m,
          ),
        };
      const cachedKey = key(event.chatId, event.id);
      const pendingStatuses = {
        ...state.pendingStatuses,
        [cachedKey]: mergeStatus(state.pendingStatuses?.[cachedKey], event.status)!,
      };
      // Keep unrelated account webhooks from growing an unbounded cache.
      const keys = Object.keys(pendingStatuses);
      if (keys.length > 500) delete pendingStatuses[keys[0]];
      return { ...state, pendingStatuses };
    }
    case 'sent': {
      const local = state.messages.find((m) => m.id === action.localId);
      if (!local) return state;
      const duplicate = state.messages.find(
        (m) => m.chatId === local.chatId && m.id === action.idMessage && m.id !== action.localId,
      );
      const cachedKey = key(local.chatId, action.idMessage);
      const pendingStatuses = { ...state.pendingStatuses };
      const status = mergeStatus(
        mergeStatus(mergeStatus(local.status, 'queued'), duplicate?.status),
        pendingStatuses[cachedKey],
      );
      delete pendingStatuses[cachedKey];
      return {
        ...state,
        pendingStatuses,
        messages: state.messages
          .filter((m) => m !== duplicate)
          .map((m) => (m === local ? { ...local, id: action.idMessage, status } : m)),
      };
    }
    case 'failed':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.localId
            ? { ...m, status: mergeStatus(m.status, action.uncertain ? 'uncertain' : 'failed') }
            : m,
        ),
      };
  }
}
