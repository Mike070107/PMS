import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';

export function createUploadPasteTargetRegistry() {
  let activeId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    getActive: () => activeId,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate(id: string) {
      if (activeId === id) return;
      activeId = id;
      listeners.forEach((listener) => listener());
    },
    release(id: string) {
      if (activeId !== id) return;
      activeId = null;
      listeners.forEach((listener) => listener());
    },
  };
}

const pasteTargetRegistry = createUploadPasteTargetRegistry();

/**
 * rc-upload 的 pastable 会监听整个 document。同页多个上传区同时开启时，
 * 一张截图会被每个区域各上传一次。这里统一保证只有最近悬停、点击或聚焦的
 * 照片区域能接收 Ctrl+V。
 */
export function useUploadPasteTarget() {
  const id = useId();
  const pastable = useSyncExternalStore(
    pasteTargetRegistry.subscribe,
    () => pasteTargetRegistry.getActive() === id,
    () => false,
  );
  const activate = useCallback(() => pasteTargetRegistry.activate(id), [id]);

  useEffect(() => () => pasteTargetRegistry.release(id), [id]);

  return {
    pastable,
    pasteTargetProps: {
      onMouseEnter: activate,
      onPointerDownCapture: activate,
      onFocusCapture: activate,
      'data-paste-upload-target': pastable ? 'active' : 'inactive',
    },
  };
}
