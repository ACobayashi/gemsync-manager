const GEMSYNC_TYPES = new Set([
  "gemsync:sync-page",
  "gemsync:bind-page",
  "gemsync:open-gemini",
]);

const findGeminiTab = async ({ conversationId, geminiUrl }) => {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  if (conversationId) {
    const exact = tabs.find((tab) => tab.url && tab.url.includes(`/app/${conversationId}`));
    if (exact) return exact;
  }

  if (geminiUrl) {
    const target = new URL(geminiUrl);
    const exact = tabs.find((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return url.origin === target.origin && url.pathname === target.pathname;
      } catch {
        return false;
      }
    });
    if (exact) return exact;
  }

  return tabs.find((tab) => tab.active) || tabs[0] || null;
};

const sendToTab = (tabId, payload) => {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response || { ok: false, error: "Gemini 页面没有回应。" });
    });
  });
};

const activateTab = async (tab) => {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
};

const handleGemSync = async (message) => {
  const payload = message.payload || {};
  const tab = await findGeminiTab(payload);

  if (message.type === "gemsync:open-gemini") {
    if (tab?.id) {
      await activateTab(tab);
      if (payload.geminiUrl && tab.url && !tab.url.includes(`/app/${payload.conversationId}`)) {
        await chrome.tabs.update(tab.id, { url: payload.geminiUrl, active: true });
        return { ok: true, needLoad: true };
      }
      return { ok: true };
    }
    await chrome.tabs.create({ url: payload.geminiUrl || "https://gemini.google.com/app" });
    return { ok: true, needLoad: true };
  }

  if (!tab?.id) {
    await chrome.tabs.create({ url: payload.geminiUrl || "https://gemini.google.com/app" });
    return { ok: true, needLoad: true };
  }

  if (payload.geminiUrl && payload.conversationId && tab.url && !tab.url.includes(`/app/${payload.conversationId}`)) {
    await chrome.tabs.update(tab.id, { url: payload.geminiUrl, active: true });
    return { ok: true, needLoad: true };
  }

  const response = await sendToTab(tab.id, {
    type: message.type,
    payload,
  });

  if (!response.ok && /receiving end|Could not establish/i.test(response.error || "")) {
    return { ok: true, needLoad: true };
  }

  return response;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (GEMSYNC_TYPES.has(message?.type)) {
    handleGemSync(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
