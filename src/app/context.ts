import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { ChatRuntime, ViewState } from '../chat/application/runtime';

export const RuntimeContext = createContext<ChatRuntime | null>(null);

export function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) {
    throw new Error('ChatRuntime is missing from RuntimeContext');
  }

  return runtime;
}

export function useChatState<T>(selector: (state: ViewState) => T): T {
  const runtime = useRuntime();
  return useStore(runtime.store, selector);
}
