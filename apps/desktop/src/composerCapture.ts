import type { ContextAttachment } from "./bridge";
import type { BrowserHost } from "./useBrowserTabs";

export const COMPOSER_ATTACH_EVENT = "browser://composer-attach";
export const COMPOSER_INSERT_EVENT = "browser://composer-insert";

export interface ComposerAttachOffer {
  taskId: string;
  attachment: ContextAttachment;
}

export interface ComposerInsertOffer {
  taskId: string;
  text: string;
}

/**
 * Hands a capture from a popped-out browser to the main window's composer.
 * The pop-out has no composer of its own; the native file is already written
 * before this event is emitted.
 */
export async function offerComposerAttachment(
  taskId: string,
  attachment: ContextAttachment,
): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(COMPOSER_ATTACH_EVENT, { taskId, attachment } satisfies ComposerAttachOffer);
}

export async function offerComposerInsert(taskId: string, text: string): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(COMPOSER_INSERT_EVENT, { taskId, text } satisfies ComposerInsertOffer);
}

export async function listenComposerOffers(handlers: {
  onAttach?: (offer: ComposerAttachOffer) => void;
  onInsert?: (offer: ComposerInsertOffer) => void;
}): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const stops = await Promise.all([
      handlers.onAttach
        ? listen<ComposerAttachOffer>(COMPOSER_ATTACH_EVENT, (event) =>
            handlers.onAttach?.(event.payload),
          )
        : Promise.resolve(() => undefined),
      handlers.onInsert
        ? listen<ComposerInsertOffer>(COMPOSER_INSERT_EVENT, (event) =>
            handlers.onInsert?.(event.payload),
          )
        : Promise.resolve(() => undefined),
    ]);
    return () => {
      for (const stop of stops) stop();
    };
  } catch {
    return () => undefined;
  }
}

/** Composer host for the task-scoped pop-out window. */
export function poppedOutComposerHost(
  saveImage?: (
    file: Blob,
    fileName?: string,
    chatTaskId?: string,
  ) => Promise<ContextAttachment | undefined>,
): BrowserHost {
  return {
    attachImage: async (file, name, taskId) => {
      const attachment = await saveImage?.(file, name, undefined);
      if (!attachment) return;
      await offerComposerAttachment(taskId, attachment);
    },
    insertText: (text, taskId) => {
      void offerComposerInsert(taskId, text);
    },
  };
}
