(() => {
  const ALLOWED_TYPES = new Set([
    "gemsync:sync-page",
    "gemsync:bind-page",
    "gemsync:open-gemini",
  ]);

  const respond = (id, result) => {
    window.postMessage({
      source: "gemsync-extension",
      id,
      ...result,
    }, window.location.origin);
  };

  let chromeContextInvalidated = false;

  const isContextInvalidatedError = (error) => {
    return /Extension context invalidated|context invalidated/i.test(String(error?.message || error || ""));
  };

  const getChromeRuntime = () => {
    if (chromeContextInvalidated) return null;
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      return runtime?.id ? runtime : null;
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      return null;
    }
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;

    const message = event.data;
    if (message?.source !== "gemsync-app" || !ALLOWED_TYPES.has(message.type)) return;

    try {
      const runtime = getChromeRuntime();
      if (!runtime?.sendMessage) {
        respond(message.id, { ok: false, error: "Extension context expired. Refresh this page." });
        return;
      }

      runtime.sendMessage({
        type: message.type,
        payload: message.payload,
      }, (response) => {
        try {
          const error = runtime.lastError;
          if (error) {
            respond(message.id, { ok: false, error: error.message });
            return;
          }
          respond(message.id, response || { ok: false, error: "Extension did not return a result." });
        } catch (error) {
          if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
          respond(message.id, { ok: false, error: error.message || "Extension context expired. Refresh this page." });
        }
      });
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      respond(message.id, { ok: false, error: error.message || "Extension context expired. Refresh this page." });
    }
  });
})();
