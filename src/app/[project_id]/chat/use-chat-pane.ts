'use client';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CHAT_PANE_DEFAULT_WIDTH,
  CHAT_PANE_MAX_WIDTH,
  CHAT_PANE_MIN_WIDTH,
  CHAT_PANE_WIDTH_STORAGE_KEY,
  PREVIEW_PANE_MIN_WIDTH,
  clampChatPaneWidth,
  parseStoredChatPaneWidth,
} from './pane-layout';

export function useChatPane() {
  const [chatPaneWidth, setChatPaneWidth] = useState(CHAT_PANE_DEFAULT_WIDTH);
  const [isChatPaneResizing, setIsChatPaneResizing] = useState(false);
  const chatPaneRef = useRef<HTMLDivElement>(null);
  const chatPaneWidthRef = useRef(CHAT_PANE_DEFAULT_WIDTH);
  const chatPanePreferredWidthRef = useRef(CHAT_PANE_DEFAULT_WIDTH);
  const chatPaneResizeRef = useRef({
    startX: 0,
    startWidth: CHAT_PANE_DEFAULT_WIDTH,
  });
  const persistChatPaneWidth = useCallback((width: number) => {
    const nextWidth = clampChatPaneWidth(width, window.innerWidth);
    chatPaneWidthRef.current = nextWidth;
    chatPanePreferredWidthRef.current = nextWidth;
    setChatPaneWidth(nextWidth);
    window.localStorage.setItem(CHAT_PANE_WIDTH_STORAGE_KEY, String(nextWidth));
  }, []);

  const resetChatPaneWidth = useCallback(() => {
    const nextWidth = clampChatPaneWidth(CHAT_PANE_DEFAULT_WIDTH, window.innerWidth);
    chatPaneWidthRef.current = nextWidth;
    chatPanePreferredWidthRef.current = CHAT_PANE_DEFAULT_WIDTH;
    setChatPaneWidth(nextWidth);
    window.localStorage.removeItem(CHAT_PANE_WIDTH_STORAGE_KEY);
  }, []);

  const startChatPaneResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chatPaneResizeRef.current = {
      startX: event.clientX,
      startWidth: chatPaneRef.current?.getBoundingClientRect().width ?? chatPaneWidthRef.current,
    };
    setIsChatPaneResizing(true);
  }, []);

  useEffect(() => {
    const storedWidth = parseStoredChatPaneWidth(
      window.localStorage.getItem(CHAT_PANE_WIDTH_STORAGE_KEY),
      CHAT_PANE_MAX_WIDTH + PREVIEW_PANE_MIN_WIDTH
    );
    if (storedWidth !== null) {
      const visibleWidth = clampChatPaneWidth(storedWidth, window.innerWidth);
      chatPanePreferredWidthRef.current = storedWidth;
      chatPaneWidthRef.current = visibleWidth;
      setChatPaneWidth(visibleWidth);
    }

    const clampToViewport = () => {
      const nextWidth = clampChatPaneWidth(chatPanePreferredWidthRef.current, window.innerWidth);
      chatPaneWidthRef.current = nextWidth;
      setChatPaneWidth(nextWidth);
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  useEffect(() => {
    if (!isChatPaneResizing) return;

    const move = (event: PointerEvent) => {
      const nextWidth = clampChatPaneWidth(
        chatPaneResizeRef.current.startWidth + event.clientX - chatPaneResizeRef.current.startX,
        window.innerWidth
      );
      chatPaneWidthRef.current = nextWidth;
      chatPanePreferredWidthRef.current = nextWidth;
      setChatPaneWidth(nextWidth);
    };
    const stop = () => {
      window.localStorage.setItem(CHAT_PANE_WIDTH_STORAGE_KEY, String(chatPanePreferredWidthRef.current));
      setIsChatPaneResizing(false);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [isChatPaneResizing]);

  return {
    chatPaneWidth,
    isChatPaneResizing,
    chatPaneRef,
    chatPaneWidthRef,
    persistChatPaneWidth,
    resetChatPaneWidth,
    startChatPaneResize,
  };
}
