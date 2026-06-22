async function notifyPlugin(chatId) {
    if (!chatId) return;
    try {
        const ctx = window.SillyTavern.getContext();
        const headers = ctx.getRequestHeaders();
        const res = await fetch('/api/plugins/memory-proxy/set-chat-id', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId }),
        });
        if (!res.ok) {
            console.warn('[MemoryProxy] set-chat-id non-OK response:', res.status);
        }
    } catch (e) {
        // Plugin may not be loaded yet, or a transient network error. Log it so a
        // misconfigured plugin path / 500 isn't silently swallowed — otherwise the
        // server keeps using a stale chatId and memory isolation quietly breaks.
        console.warn('[MemoryProxy] set-chat-id failed:', e?.message || e);
    }
}

function init() {
    const ctx = window.SillyTavern.getContext();
    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes;

    // Notify on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        const chatId = window.SillyTavern.getContext().chatId;
        await notifyPlugin(chatId);
    });

    // Also notify immediately (current chat may already be open)
    notifyPlugin(ctx.chatId);

    // Re-notify on every request to keep in sync. Also stash chat_id into the
    // request body so the server can resolve the session per-request (multi-tab safe).
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, (generate_data) => {
        const chatId = window.SillyTavern.getContext().chatId;
        if (chatId) {
            generate_data.chat_id = chatId;
        }
        notifyPlugin(chatId);
    });

    // Re-notify after a generation completes so the server's currentChatId is fresh
    // right when background memory extraction fires. (Extraction is scheduled after
    // the assistant response, so a stale chatId here would attribute the new turn's
    // facts to the wrong session.) Event name varies by ST version — guard each.
    const endedEvent = eventTypes.GENERATION_ENDED || eventTypes.MESSAGE_RECEIVED;
    if (endedEvent) {
        eventSource.on(endedEvent, () => {
            notifyPlugin(window.SillyTavern.getContext().chatId);
        });
    }
}

export { init };
