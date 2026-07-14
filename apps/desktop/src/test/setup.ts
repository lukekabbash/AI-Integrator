import "@testing-library/jest-dom/vitest";

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
