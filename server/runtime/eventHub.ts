import type { RuntimeEvent } from './contracts.js';

type EventListener = (event: RuntimeEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();

  publish(event: RuntimeEvent) {
    for (const listener of this.globalListeners) listener(event);
    for (const listener of this.listeners.get(event.taskId) ?? []) listener(event);
  }

  subscribeAll(listener: EventListener) {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  subscribe(taskId: string, listener: EventListener) {
    const listeners = this.listeners.get(taskId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(taskId);
    };
  }
}
