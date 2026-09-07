import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { isNearConversationBottom } from './conversationInteraction';

export function useConversationScroll(conversationId: string | null, content: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousId = useRef<string | null | undefined>(undefined);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);
  const scrollToLatest = useCallback(() => {
    following.current = true;
    setShowLatest(false);
    const element = scrollRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      lastScrollTop.current = element.scrollTop;
    }
  }, []);
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // A delayed layout can dispatch scroll before ResizeObserver. Only an
    // upward position change should detach a reader who was following latest.
    following.current = isNearConversationBottom(element)
      || (following.current && element.scrollTop >= lastScrollTop.current - 1);
    lastScrollTop.current = element.scrollTop;
    setShowLatest(!following.current);
  }, []);

  useLayoutEffect(() => {
    const changed = previousId.current !== conversationId;
    previousId.current = conversationId;
    if (changed || following.current) scrollToLatest();
  }, [conversationId, content, scrollToLatest]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToLatest();
    });
    observer.observe(element, { box: 'border-box' });
    for (const child of element.children) observer.observe(child, { box: 'border-box' });
    return () => observer.disconnect();
  }, [conversationId, content, scrollToLatest]);

  return { scrollRef, onScroll, showLatest, scrollToLatest };
}
