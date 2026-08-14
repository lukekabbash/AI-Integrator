import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  readonly matches = false;
  readonly media: string;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;

  constructor(query: string) {
    super();
    this.media = query;
  }

  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null) {
    if (listener) this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null) {
    if (listener) this.removeEventListener("change", listener as EventListener);
  }
}

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function createCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const noOp = () => undefined;
  const imageData = () =>
    ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
      colorSpace: "srgb",
    }) as ImageData;
  const context: Partial<CanvasRenderingContext2D> = {
    canvas,
    measureText: (text) =>
      ({
        width: String(text).length * 8,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
      }) as TextMetrics,
    createLinearGradient: () => ({ addColorStop: noOp }) as CanvasGradient,
    createRadialGradient: () => ({ addColorStop: noOp }) as CanvasGradient,
    createPattern: () => null,
    getImageData: imageData,
    createImageData: imageData,
  };

  return new Proxy(context, {
    get(target, property) {
      return Reflect.get(target, property) ?? noOp;
    },
    set(target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  }) as CanvasRenderingContext2D;
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => new TestMediaQueryList(query),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: TestResizeObserver,
  });
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: TestIntersectionObserver,
  });
}

if (typeof Element !== "undefined") {
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value(this: Element, optionsOrX?: ScrollToOptions | number, y?: number) {
      if (typeof optionsOrX === "number") {
        this.scrollLeft = optionsOrX;
        if (typeof y === "number") this.scrollTop = y;
        return;
      }
      if (typeof optionsOrX?.left === "number") this.scrollLeft = optionsOrX.left;
      if (typeof optionsOrX?.top === "number") this.scrollTop = optionsOrX.top;
    },
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
}

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, contextId: string) {
      return contextId === "2d" ? createCanvasContext(this) : null;
    },
  });
}

// Node 26 ships an experimental global `localStorage` that is undefined unless
// --localstorage-file is passed, and it shadows jsdom's implementation in the
// vitest environment. Install an in-memory Storage when that happens.
function createMemoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store = new Map();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof window !== "undefined" && !window[name]) {
    Object.defineProperty(window, name, {
      value: createMemoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}
