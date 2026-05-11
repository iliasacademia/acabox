import type { ChatStreamMessage } from '../shared/types';

export interface OverlayChatSendParams {
  sessionId: string;
  text: string;
  documentPath?: string;
  selectedText?: string;
  onEvent: (msg: ChatStreamMessage) => void;
  onDone: () => void;
  onError: (err: string) => void;
  onCleanup?: () => void;
}

export type OverlayChatSendHandler = (params: OverlayChatSendParams) => void;

export interface OverlayBridgeParams {
  action: string;
  payload: Record<string, unknown>;
  wid: string | null;
}

export type OverlayBridgeHandler = (params: OverlayBridgeParams) => Promise<unknown>;

let chatSendHandler: OverlayChatSendHandler | null = null;
let bridgeHandler: OverlayBridgeHandler | null = null;

export function setOverlayChatSendHandler(handler: OverlayChatSendHandler): void {
  chatSendHandler = handler;
}

export function getOverlayChatSendHandler(): OverlayChatSendHandler | null {
  return chatSendHandler;
}

export function setOverlayBridgeHandler(handler: OverlayBridgeHandler): void {
  bridgeHandler = handler;
}

export function getOverlayBridgeHandler(): OverlayBridgeHandler | null {
  return bridgeHandler;
}
