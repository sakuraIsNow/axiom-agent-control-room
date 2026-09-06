import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isNearConversationBottom } from './conversationInteraction';

export function useConversationScroll(conversationId: string | null, content: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousId = useRef<string | null | undefined>(undefined);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const scrollToLatest = useCallback(() => {
    following.current = true;
    setShowLatest(false);
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = isNearConversationBottom(element);
    setShowLatest(!following.current);
  }, []);

  useLayoutEffect(() => {
    const changed = previousId.current !== conversationId;
    previousId.current = conversationId;
    if (changed || following.current) scrollToLatest();
  }, [conversationId, content, scrollToLatest]);

  return { scrollRef, onScroll, showLatest, scrollToLatest };
}
