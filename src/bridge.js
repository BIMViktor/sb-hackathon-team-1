/**
 * Popout window ↔ widget bridge.
 *
 * The popout is a normal browser window with no StreamBIM connection. It
 * forwards REST calls to the widget iframe that opened it (window.opener),
 * which runs them with its own client. Same origin on both sides.
 */

const HOST = "um-host";
const POPOUT = "um-popout";

/** In the widget: answer REST calls from popouts we opened. */
export function serveBridge(getContext) {
  window.addEventListener("message", async (event) => {
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== POPOUT || !event.source) return;
    const reply = (payload) => event.source.postMessage({ source: HOST, id: msg.id, ...payload }, location.origin);
    const { rest, projectId, userEmail, mode } = getContext();
    if (msg.call === "context") return reply({ ok: true, value: { projectId, userEmail, mode } });
    if (msg.call !== "rest" || !rest) return reply({ ok: false, error: "Widgeten är inte ansluten." });
    try {
      reply({ ok: true, value: await rest(msg.path, msg.opts) });
    } catch (error) {
      reply({ ok: false, error: error?.message || String(error), blind: Boolean(error?.blind) });
    }
  });
}

/** In the popout: a rest() and context() that go through the opener. */
export function connectBridge() {
  const opener = window.opener;
  if (!opener) return null;
  let seq = 0;
  const pending = new Map();
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== HOST || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.ok) resolve(msg.value);
    else reject(Object.assign(new Error(msg.error), { blind: msg.blind }));
  });
  const call = (payload) =>
    new Promise((resolve, reject) => {
      if (opener.closed) return reject(new Error("Widgeten stängdes. Öppna fönstret igen från StreamBIM."));
      const id = ++seq;
      pending.set(id, { resolve, reject });
      opener.postMessage({ source: POPOUT, id, ...payload }, location.origin);
    });
  return {
    context: () => call({ call: "context" }),
    rest: (path, opts = {}) => call({ call: "rest", path, opts }),
  };
}
