export type Credentials = { apiUrl: string; idInstance: string; apiTokenInstance: string };
export type MessageStatus =
  'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'uncertain';
export type Message = {
  id: string;
  chatId: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  status?: MessageStatus;
};
export type Chat = { id: string; name: string; phone?: string; unread: number };
export type ChatEvent =
  | { kind: 'message'; message: Message; name?: string }
  | { kind: 'status'; id: string; chatId: string; status: MessageStatus };
export interface Transport {
  connect(signal: AbortSignal): Promise<void>;
  resolvePhone(phone: string, signal: AbortSignal): Promise<{ chatId: string }>;
  send(chatId: string, message: string, signal: AbortSignal): Promise<{ idMessage: string }>;
  listen(
    onEvent: (event: ChatEvent) => void,
    onState: (state: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
