import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenId(token) {
  return createHash("sha256").update(token).digest("hex");
}

function accessError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

export class AccessService {
  constructor({ sessionStore, adminPin, gmPin, persistGmPin = null, now = () => new Date() }) {
    this.sessionStore = sessionStore;
    this.adminPin = adminPin;
    this.gmPin = gmPin;
    this.now = now;
    this.persistGmPin = persistGmPin;
    this.pairingGuard = { failures: 0, blockedUntil: 0 };
  }

  async pair({ role, pin = "", campaignId = null, characterId = null, deviceName = "Browser" }) {
    if (!this.adminPin || !this.gmPin) throw accessError("Access PINs are not configured", 503);
    if (this.pairingGuard.blockedUntil > this.now().getTime()) throw accessError("Too many failed pairing attempts; try again shortly", 429);
    const invalidPin = (role === "admin" && !secureEqual(pin, this.adminPin)) || (role === "gm" && !secureEqual(pin, this.gmPin));
    if (invalidPin) {
      this.pairingGuard.failures += 1;
      if (this.pairingGuard.failures >= 5) { this.pairingGuard.failures = 0; this.pairingGuard.blockedUntil = this.now().getTime() + 60_000; }
      throw accessError(role === "admin" ? "Invalid Admin PIN" : "Invalid GM PIN", 401);
    }
    if (!['admin', 'gm', 'player'].includes(role)) throw accessError("Invalid access role", 422);
    if (role === "gm" && !campaignId) throw accessError("GM access requires a campaign", 422);
    if (role === "player" && (!campaignId || !characterId)) throw accessError("Player access requires a campaign and character", 422);
    if (role === "admin" || role === "gm") { this.pairingGuard.failures = 0; this.pairingGuard.blockedUntil = 0; }

    const token = randomBytes(32).toString("hex");
    const createdAt = this.now();
    const session = {
      session_id: tokenId(token),
      name: `${role}-${createdAt.toISOString()}`,
      role,
      campaign_id: campaignId,
      character_id: characterId,
      device_name: String(deviceName || "Browser").trim().slice(0, 80),
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + SESSION_LIFETIME_MS).toISOString(),
    };
    await this.sessionStore.put(session.session_id, session);
    return { token, session };
  }

  async authenticate(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) throw accessError("Pair this device to continue", 401);
    const token = authorization.slice(7).trim();
    if (!token) throw accessError("Pair this device to continue", 401);
    const session = await this.sessionStore.get(tokenId(token));
    if (!session) throw accessError("Access session is invalid", 401);
    if (Date.parse(session.expires_at) <= this.now().getTime()) {
      await this.sessionStore.delete(session.session_id);
      throw accessError("Access session has expired", 401);
    }
    return session;
  }

  async authorize(request, { roles, campaignId = null, characterId = null }) {
    const session = await this.authenticate(request);
    if (session.role === "admin") return session;
    if (!roles.includes(session.role)) throw accessError("This device does not have permission", 403);
    if (campaignId && session.campaign_id !== campaignId) throw accessError("This device is paired to another campaign", 403);
    if (characterId && session.role === "player" && session.character_id !== characterId) throw accessError("This device is paired to another character", 403);
    return session;
  }

  async revoke(request) {
    const session = await this.authenticate(request);
    await this.sessionStore.delete(session.session_id);
  }

  async list() {
    const now = this.now().getTime();
    return (await this.sessionStore.list()).filter((session) => Date.parse(session.expires_at) > now);
  }

  sessionDedupeKey(session) {
    return [
      session.role || "",
      String(session.device_name || "Browser").trim().toLowerCase(),
      session.campaign_id || "",
      session.character_id || "",
    ].join("|");
  }

  dedupeSessions(sessions, currentSession = null) {
    const deduped = new Map();
    for (const session of sessions) {
      const key = this.sessionDedupeKey(session);
      const existing = deduped.get(key);
      const sessionIsCurrent = session.session_id === currentSession?.session_id;
      const existingIsCurrent = existing?.session_id === currentSession?.session_id;
      const sessionCreated = Date.parse(session.created_at || session.expires_at || 0);
      const existingCreated = Date.parse(existing?.created_at || existing?.expires_at || 0);
      if (!existing || sessionIsCurrent || (!existingIsCurrent && sessionCreated > existingCreated)) deduped.set(key, session);
    }
    return [...deduped.values()].sort((left, right) => Date.parse(right.created_at || right.expires_at || 0) - Date.parse(left.created_at || left.expires_at || 0));
  }

  async visibleSessions(request) {
    const current = await this.authorize(request, { roles: ["admin"] });
    return this.dedupeSessions(await this.list(), current);
  }

  async revokeById(sessionId) {
    return this.sessionStore.delete(sessionId);
  }

  async revokeOthers(request) {
    const current = await this.authorize(request, { roles: ["admin"] });
    const sessions = await this.list();
    const revoked = sessions.filter((session) => session.session_id !== current.session_id);
    await Promise.all(revoked.map((session) => this.sessionStore.delete(session.session_id)));
    return revoked.length;
  }

  pairingInfo() {
    return { gm_pin: this.gmPin };
  }

  async rotateGmPin() {
    if (!this.persistGmPin) throw accessError("GM PIN rotation is unavailable on this platform", 503);
    const gmPin = String(randomInt(100000, 1_000_000));
    await this.persistGmPin(gmPin);
    this.gmPin = gmPin;
    const sessions = await this.list();
    await Promise.all(sessions.filter((session) => session.role === "gm").map((session) => this.sessionStore.delete(session.session_id)));
    return gmPin;
  }
}
