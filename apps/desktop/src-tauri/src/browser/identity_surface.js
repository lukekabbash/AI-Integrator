/**
 * Describe this tab the way a current desktop browser would.
 *
 * Runs in every frame before page scripts. Identity providers (Google among
 * them) read Client Hints and `navigator.userAgentData` even when the host
 * has already replaced the User-Agent string, and the embedded engine still
 * names itself there. Align those brands with the UA the host set, and never
 * leave an embedded product token or `navigator.webdriver` for a sign-in
 * page to see.
 */
(() => {
  const SURFACE = window.__integratorSurface ?? {};
  delete window.__integratorSurface;
  const major = String(SURFACE.major ?? "");
  const platform = String(SURFACE.platform ?? "");
  if (!major || platform !== "Windows") return;

  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not)A;Brand", version: "8" },
  ];
  const fullVersion = `${major}.0.0.0`;
  const fullVersionList = [
    { brand: "Chromium", version: fullVersion },
    { brand: "Google Chrome", version: fullVersion },
    { brand: "Not)A;Brand", version: "10.0.0.4" },
  ];
  const highEntropy = {
    architecture: "x86",
    bitness: "64",
    brands,
    fullVersionList,
    mobile: false,
    model: "",
    platform: "Windows",
    platformVersion: "19.0.0",
    uaFullVersion: fullVersion,
    wow64: false,
  };
  const userAgentData = {
    brands,
    mobile: false,
    platform: "Windows",
    getHighEntropyValues(hints) {
      const values = { brands, mobile: false, platform: "Windows" };
      for (const hint of hints ?? []) {
        if (Object.hasOwn(highEntropy, hint)) values[hint] = highEntropy[hint];
      }
      return Promise.resolve(values);
    },
    toJSON() {
      return { brands, mobile: false, platform: "Windows" };
    },
  };

  try {
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      configurable: true,
      get() {
        return userAgentData;
      },
    });
  } catch {
    try {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        get() {
          return userAgentData;
        },
      });
    } catch {
      /* a page that froze Navigator leaves the engine's brands in place */
    }
  }

  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get() {
        return false;
      },
    });
  } catch {
    try {
      Object.defineProperty(navigator, "webdriver", {
        configurable: true,
        get() {
          return false;
        },
      });
    } catch {
      /* same: a frozen Navigator is left as the engine built it */
    }
  }
})();
