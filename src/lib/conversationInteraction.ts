type SubmitKey = { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number };

export const isConversationSubmitKey = (event: SubmitKey) => event.key === 'Enter'
  && !event.shiftKey && !event.isComposing && event.keyCode !== 229;

export const isNearConversationBottom = (element: { scrollHeight: number; clientHeight: number; scrollTop: number }) =>
  element.scrollHeight - element.clientHeight - element.scrollTop <= 48;
