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

  // Applies a registry change that affects how the bot runs (IMEIs or level) by
  // hot-swapping the config inside the existing runtime. We deliberately DO NOT
  // stop and restart the runtime here: creating a new TelegramBot on the same token
  // while the previous poller is still in-flight causes Telegram to return 409s on
  // the reserved long-poll slot for up to ~50s, and node-telegram-bot-api keeps
  // retrying on failure, accumulating a ghost poller with every restart (duplicated
  // replies, missed updates, log spam). The Telegram connection is independent of
  // the mutable config, so an in-place update is both correct and safe.
  function applyLiveUpdate(id, mutate) {
    const updated = mutate();
    persist();
    const runtime = runningBots.get(id);
    if (runtime) runtime.applyConfig(getBot(registry, id));
    else startRuntime(getBot(registry, id));
    return updated;
  }

  const addImei = (id, imei) => applyLiveUpdate(id, () => registryAddImei(registry, id, imei));
  const removeImei = (id, imei) => applyLiveUpdate(id, () => registryRemoveImei(registry, id, imei));
  const setLevel = (id, level) => applyLiveUpdate(id, () => registryUpdateBot(registry, id, { level }));

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

  // Stops every running bot's Telegram long-poll. Call this on process shutdown
  // (SIGTERM/SIGINT) so a redeploy's old container releases its getUpdates
  // connections before the new container starts polling the same tokens —
  // otherwise the two briefly fight over the same connection (Telegram 409s).
  async function stopAll() {
    await Promise.all([...runningBots.values()].map((runtime) => runtime.stop()));
    runningBots.clear();
  }

  return { startAll, addBot, removeBot, addImei, removeImei, setLevel, list, pollAll, stopAll, hasBot: (id) => runningBots.has(id) };
}
