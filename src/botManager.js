import { createBotRuntime } from './botRuntime.js';
import {
  loadRegistry, saveRegistry, addBot as registryAddBot, removeBot as registryRemoveBot,
  updateBot as registryUpdateBot, addImei as registryAddImei, removeImei as registryRemoveImei, getBot,
} from './registry.js';

// Owns the registry (source of truth on disk) and the map of live bot runtimes.
// Both the runner (index.js) and the manager bot drive everything through here, so
// registry writes and runtime start/stop always stay in lockstep.
export function createBotManager() {
  let registry = loadRegistry();
  const runningBots = new Map(); // id -> runtime

  function startAll() {
    for (const botConfig of registry.bots) {
      startRuntime(botConfig);
    }
    return [...runningBots.keys()];
  }

  function startRuntime(botConfig) {
    const runtime = createBotRuntime(botConfig);
    runtime.start();
    runningBots.set(botConfig.id, runtime);
    return runtime;
  }

  async function stopRuntime(id) {
    const runtime = runningBots.get(id);
    if (runtime) {
      await runtime.stop();
      runningBots.delete(id);
    }
  }

  function persist() {
    registry = saveRegistry(registry);
  }

  async function addBot(rawBotConfig) {
    const bot = registryAddBot(registry, rawBotConfig);
    persist();
    startRuntime(bot);
    return bot;
  }

  async function removeBot(id) {
    const removed = registryRemoveBot(registry, id);
    persist();
    await stopRuntime(id);
    return removed;
  }

  // Applies a registry change that affects how the bot runs (IMEIs or level), then
  // restarts that bot's runtime so it picks the change up cleanly.
  async function applyAndRestart(id, mutate) {
    const updated = mutate();
    persist();
    await stopRuntime(id);
    startRuntime(getBot(registry, id));
    return updated;
  }

  const addImei = (id, imei) => applyAndRestart(id, () => registryAddImei(registry, id, imei));
  const removeImei = (id, imei) => applyAndRestart(id, () => registryRemoveImei(registry, id, imei));
  const setLevel = (id, level) => applyAndRestart(id, () => registryUpdateBot(registry, id, { level }));

  function list() {
    return registry.bots.map((b) => ({ ...b, running: runningBots.has(b.id) }));
  }

  async function pollAll() {
    for (const [id, runtime] of runningBots.entries()) {
      try {
        await runtime.pollOnce();
      } catch (err) {
        console.error(`[${id}] Poll cycle failed:`, err.message);
      }
    }
  }

  return { startAll, addBot, removeBot, addImei, removeImei, setLevel, list, pollAll, hasBot: (id) => runningBots.has(id) };
}
