import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoTransport } from '../src/lib/demo';
import type { ChatEvent } from '../src/types';

describe('DemoTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects and resolves a phone deterministically without network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const demo = new DemoTransport();
    const signal = new AbortController().signal;
    const connect = demo.connect(signal);
    await vi.advanceTimersByTimeAsync(250);
    await connect;
    const first = demo.resolvePhone('+1 (555) 123-4567', signal);
    await vi.advanceTimersByTimeAsync(180);
    expect(await first).toEqual({ chatId: '15551234567@c.us' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('starts empty, then delivers statuses and one generic reply', async () => {
    const demo = new DemoTransport();
    const controller = new AbortController();
    const events: ChatEvent[] = [];
    const states = vi.fn();
    const listener = demo.listen((event) => events.push(event), states, controller.signal);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual([]);
    const send = demo.send('demo@c.us', 'Hi', controller.signal);
    await vi.advanceTimersByTimeAsync(250);
    const { idMessage } = await send;
    await vi.advanceTimersByTimeAsync(1500);
    expect(events.filter((e) => e.kind === 'status').map((e) => e.status)).toEqual([
      'sent',
      'delivered',
      'read',
    ]);
    expect(events[0]).toMatchObject({ id: idMessage });
    expect(events[3]).toMatchObject({
      kind: 'message',
      name: 'Демо-собеседник',
      message: { outgoing: false, chatId: 'demo@c.us' },
    });
    expect(states).toHaveBeenCalledWith('Демонстрационный режим');
    controller.abort();
    await listener;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts pending operations without adding events', async () => {
    const demo = new DemoTransport();
    const controller = new AbortController();
    const send = demo.send('demo@c.us', 'Hi', controller.signal);
    const rejection = expect(send).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    const listenerController = new AbortController();
    const events = vi.fn();
    const listener = demo.listen(events, vi.fn(), listenerController.signal);
    await vi.advanceTimersByTimeAsync(2500);
    expect(events).not.toHaveBeenCalled();
    listenerController.abort();
    await listener;
  });
  it('only allows one consume loop and can restart after cancellation', async () => {
    const demo = new DemoTransport();
    const one = new AbortController();
    const running = demo.listen(vi.fn(), vi.fn(), one.signal);
    await expect(demo.listen(vi.fn(), vi.fn(), new AbortController().signal)).rejects.toThrow(
      'already running',
    );
    one.abort();
    await running;
    const two = new AbortController();
    const restarted = demo.listen(vi.fn(), vi.fn(), two.signal);
    two.abort();
    await restarted;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects an already aborted operation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new DemoTransport().connect(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
