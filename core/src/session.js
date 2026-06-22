const MODES = new Set(["game", "battle"]);

export function emptySession(campaignId) {
  return {
    campaign_id: campaignId,
    mode: "game",
    scene: { title: "", description: "" },
    battle: { round: 0, turn_index: 0, combatants: [] },
    updated_at: null,
  };
}

export function normalizeSession(campaignId, input) {
  if (!MODES.has(input.mode)) {
    const error = new Error("mode must be game or battle");
    error.statusCode = 422;
    throw error;
  }

  const combatants = Array.isArray(input.battle?.combatants) ? input.battle.combatants : [];
  if (combatants.length > 100) {
    const error = new Error("battle cannot exceed 100 combatants");
    error.statusCode = 422;
    throw error;
  }

  const seen = new Set();
  const normalizedCombatants = combatants.map((combatant) => {
    if (typeof combatant.combatant_id !== "string" || typeof combatant.name !== "string" || !combatant.name.trim()) {
      const error = new Error("each combatant requires combatant_id and name");
      error.statusCode = 422;
      throw error;
    }
    if (seen.has(combatant.combatant_id)) {
      const error = new Error("combatant_id values must be unique");
      error.statusCode = 422;
      throw error;
    }
    seen.add(combatant.combatant_id);
    return {
      combatant_id: combatant.combatant_id,
      name: combatant.name.trim(),
      initiative: Number.isFinite(Number(combatant.initiative)) ? Number(combatant.initiative) : 0,
      player_visible: combatant.player_visible !== false,
      source: combatant.source === "character" ? "character" : "npc",
      character_id: combatant.source === "character" && typeof combatant.character_id === "string" ? combatant.character_id : null,
      health: combatant.health && typeof combatant.health === "object" ? (() => {
        const maximum = Math.max(0, Number.isFinite(Number(combatant.health.maximum)) ? Number(combatant.health.maximum) : 0);
        const current = Number.isFinite(Number(combatant.health.current)) ? Number(combatant.health.current) : 0;
        return { current: Math.max(0, Math.min(maximum, current)), maximum };
      })() : null,
      conditions: Array.isArray(combatant.conditions) ? [...new Set(combatant.conditions.map((condition) => String(condition).trim()).filter(Boolean))].slice(0, 20) : [],
      defeated: Boolean(combatant.defeated) || Boolean(combatant.health && Number(combatant.health.current) <= 0),
    };
  }).sort((left, right) => right.initiative - left.initiative);

  return {
    campaign_id: campaignId,
    mode: input.mode,
    scene: {
      title: typeof input.scene?.title === "string" ? input.scene.title.trim() : "",
      description: typeof input.scene?.description === "string" ? input.scene.description.trim() : "",
    },
    battle: {
      round: input.mode === "battle" && normalizedCombatants.length ? Math.max(1, Number(input.battle?.round) || 1) : 0,
      turn_index: Math.min(Math.max(0, Number(input.battle?.turn_index) || 0), Math.max(0, normalizedCombatants.length - 1)),
      combatants: normalizedCombatants,
    },
    updated_at: new Date().toISOString(),
  };
}

export function updateCombatant(session, combatantId, input) {
  if (session.mode !== "battle") {
    const error = new Error("battle mode is not active");
    error.statusCode = 409;
    throw error;
  }
  let updatedCombatant = null;
  const combatants = session.battle.combatants.map((combatant) => {
    if (combatant.combatant_id !== combatantId) return combatant;
    let health = combatant.health;
    if (health && Number.isFinite(Number(input.health_change))) {
      const maximum = Math.max(0, Number(health.maximum));
      health = { ...health, current: Math.max(0, Math.min(maximum, Number(health.current) + Number(input.health_change))) };
    }
    const conditions = input.conditions === undefined
      ? combatant.conditions
      : [...new Set((Array.isArray(input.conditions) ? input.conditions : []).map((condition) => String(condition).trim()).filter(Boolean))].slice(0, 20);
    updatedCombatant = { ...combatant, health, conditions, defeated: health ? health.current <= 0 : Boolean(input.defeated ?? combatant.defeated) };
    return updatedCombatant;
  });
  if (!updatedCombatant) {
    const error = new Error("combatant not found");
    error.statusCode = 404;
    throw error;
  }
  return { ...session, battle: { ...session.battle, combatants }, updated_at: new Date().toISOString() };
}

export function endBattle(session) {
  return { ...session, mode: "game", battle: { round: 0, turn_index: 0, combatants: [] }, updated_at: new Date().toISOString() };
}

export function advanceTurn(session) {
  if (session.mode !== "battle" || session.battle.combatants.length === 0) {
    const error = new Error("battle mode requires at least one combatant");
    error.statusCode = 409;
    throw error;
  }
  const nextIndex = (session.battle.turn_index + 1) % session.battle.combatants.length;
  return {
    ...session,
    battle: {
      ...session.battle,
      turn_index: nextIndex,
      round: nextIndex === 0 ? session.battle.round + 1 : session.battle.round,
    },
    updated_at: new Date().toISOString(),
  };
}
