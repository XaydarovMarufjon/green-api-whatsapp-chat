import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState } from '../src/lib/chatState';
import type { ChatState } from '../src/lib/chatState';
import type { Message, MessageStatus } from '../src/types';

const message: Message = {
  id: 'm1',
  chatId: 'chat1',
  text: 'Hello',
  timestamp: 1,
  outgoing: false,
};
function receive(state: ChatState, incoming: Message = message) {
  return chatReducer(state, { type: 'event', event: { kind: 'message', message: incoming } });
}
function status(state: ChatState, next: MessageStatus, id = 'm1') {
  return chatReducer(state, {
    type: 'event',
    event: { kind: 'status', id, chatId: 'chat1', status: next },
  });
}

describe('chatReducer', () => {
  it('deduplicates messages and increments unread only once', () => {
    const once = receive(initialChatState);
    const twice = receive(once);
    expect(twice.messages).toHaveLength(1);
    expect(twice.chats).toHaveLength(1);
    expect(twice.chats[0].unread).toBe(1);
    expect(initialChatState.messages).toEqual([]);
  });
  it('clears unread on selection and does not count active or outgoing messages', () => {
    let state = chatReducer(receive(initialChatState), { type: 'select', id: 'chat1' });
    state = receive(state, { ...message, id: 'm2' });
    state = receive(state, { ...message, id: 'm3', chatId: 'chat2', outgoing: true });
    expect(state.chats.map((c) => c.unread)).toEqual([0, 0]);
  });
  it('does not duplicate or reset existing chats', () => {
    const state = receive(initialChatState);
    expect(
      chatReducer(state, { type: 'addChat', chat: { id: 'chat1', name: 'Again', unread: 0 } }),
    ).toBe(state);
  });
  it('advances acknowledgements without regressing on stale events', () => {
    let state = receive(initialChatState, { ...message, outgoing: true, status: 'queued' });
    for (const s of ['sent', 'delivered', 'read', 'delivered', 'queued'] as const)
      state = status(state, s);
    expect(state.messages[0].status).toBe('read');
    state = receive(state, { ...message, outgoing: true, status: 'sent' });
    expect(state.messages[0].status).toBe('read');
  });
  it('preserves an early status when optimistic ID is replaced by server ID', () => {
    let state = chatReducer(initialChatState, {
      type: 'optimistic',
      message: { ...message, id: 'local', outgoing: true, status: 'sending' },
    });
    state = status(state, 'read', 'server');
    state = status(state, 'delivered', 'server');
    state = chatReducer(state, { type: 'sent', localId: 'local', idMessage: 'server' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: 'server', status: 'read' });
    expect(state.pendingStatuses).toEqual({});
  });
  it('merges a server echo received before send resolves', () => {
    let state = chatReducer(initialChatState, {
      type: 'optimistic',
      message: { ...message, id: 'local', outgoing: true, status: 'sending' },
    });
    state = receive(state, { ...message, id: 'server', outgoing: true, status: 'delivered' });
    state = chatReducer(state, { type: 'sent', localId: 'local', idMessage: 'server' });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].status).toBe('delivered');
  });
  it('allows failures and recovery without replacing proven delivery', () => {
    let state = receive(initialChatState, { ...message, outgoing: true, status: 'sending' });
    state = chatReducer(state, { type: 'failed', localId: 'm1', uncertain: true });
    expect(state.messages[0].status).toBe('uncertain');
    state = status(state, 'delivered');
    state = chatReducer(state, { type: 'failed', localId: 'm1', uncertain: false });
    expect(state.messages[0].status).toBe('delivered');
  });
  it('keeps equal message IDs isolated by chat and resets everything', () => {
    let state = receive(receive(initialChatState), { ...message, chatId: 'chat2' });
    state = status(state, 'read');
    expect(state.messages[1].status).toBeUndefined();
    expect(chatReducer(state, { type: 'reset' })).toEqual(initialChatState);
  });
});
