export class LiveEvents {
  constructor() {
    this.listeners = new Map();
  }

  publish(campaignId, session) {
    for (const listener of this.listeners.get(campaignId) ?? []) listener(session);
  }

  subscribe(campaignId, listener) {
    if (!this.listeners.has(campaignId)) this.listeners.set(campaignId, new Set());
    this.listeners.get(campaignId).add(listener);
    return () => {
      const listeners = this.listeners.get(campaignId);
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(campaignId);
    };
  }

  stream(campaignId, request, response, initialSession) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (session) => response.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
    send(initialSession);
    const unsubscribe = this.subscribe(campaignId, send);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 20_000);
    request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  }
}
