import { ApiClient } from "./api-client.mjs"
import { AccountManager } from "./accounts.mjs"
import { PRODUCTION_CONFIG, assertSupportedHost, compareVersions } from "./config.mjs"
import { CredentialLoader } from "./credentials.mjs"
import { MagpieHostAdapter } from "./host-adapter.mjs"
import { ManualInitialization } from "./manual-initialization.mjs"
import { createPageServer } from "./page-service.mjs"
import { createNovaFlowProvider } from "./provider.mjs"
import { SessionManager } from "./session.mjs"
import { SkillManager } from "./skills.mjs"
import { JsonStore, defaultDataDir, randomId, secureMkdir } from "./state-store.mjs"
import { SyncEngine } from "./sync-engine.mjs"
import { createNativeControl } from "./native-control.mjs"
import { NativeProviderSync } from "./native-providers.mjs"
import { readFile } from "node:fs/promises"

let singleton = null

function hostDirectory(input) {
  const directory = input?.directory
  if (typeof directory !== "string" || !directory) {
    throw new Error("Magpie did not provide input.directory; refusing to write private NovaFlow state")
  }
  return directory
}

export async function getRuntime(input, options = {}) {
  if (process.env.NOVAFLOW_PLUGIN_CLI_CHILD === "1") throw new Error("NovaFlow runtime is disabled in CLI children")
  if (singleton) {
    singleton.attachInput(input)
    return singleton
  }
  const config = PRODUCTION_CONFIG
  const dataDir = defaultDataDir(hostDirectory(input))
  secureMkdir(dataDir)

  const api = new ApiClient(config)
  const accounts = new AccountManager({
    store: new JsonStore(`${dataDir}/keys.json`, { revision: "", ownedKeyIds: [], rows: [], updatedAt: "" }),
  })
  const session = new SessionManager({
    api,
    store: new JsonStore(`${dataDir}/session.json`, {
      status: "signed_out",
      accountId: "",
      access: "",
      refresh: "",
      expiresAt: 0,
      generation: 0,
    }),
  })
  const credentials = new CredentialLoader({ api, session, accounts, config })
  const host = new MagpieHostAdapter({
    magpiePath: options.magpiePath || process.env.MAGPIE_CLI_PATH || process.env.MAGPIE_BIN || "",
    directory: input.directory,
  })
  const hostAvailable = await host.initialize()
  const hostVersion = host.version || config.hostMinVersion
  if (hostAvailable && compareVersions(hostVersion, config.hostMinVersion) < 0) {
    assertSupportedHost(hostVersion)
  }
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const nativeProviders = new NativeProviderSync({
    directory: input.directory, config, host, accounts, session,
    icon: pkg.magpie?.icon || "",
    store: new JsonStore(`${dataDir}/native-providers.json`, { entries: {} }),
  })
  const preferencesStore = new JsonStore(`${dataDir}/preferences.json`, {
    targetAgents: [],
    autoSyncSkills: false,
  })
  const preferences = preferencesStore.read()
  const instanceStore = new JsonStore(`${dataDir}/instance.json`, { instanceId: "" })
  const instance = instanceStore.read()
  if (!instance.instanceId) {
    instance.instanceId = randomId(24)
    instanceStore.write(instance)
  }
  const defaults = new ManualInitialization({
    host, accounts, directory: input.directory,
    markerStore: new JsonStore(`${dataDir}/install-defaults-marker.json`, {
      status: "wait_config",
      reason: "wait_config",
      instanceId: instance.instanceId,
      fields: {},
    }),
    backupStore: new JsonStore(`${dataDir}/install-defaults-backup.json`, {}),
  })
  const skillManager = new SkillManager({
    dataDir,
    host,
    api,
    session,
    store: new JsonStore(`${dataDir}/skill-registry.json`, { entries: {} }),
  })
  const sync = new SyncEngine({
    config,
    api,
    session,
    credentials,
    accounts,
    nativeProviders,
    skills: skillManager,
    defaults,
    preferences,
    hostVersion,
    instanceId: instance.instanceId,
    snapshotStore: new JsonStore(`${dataDir}/sync-state.json`, { state: null }),
  })
  const control = createNativeControl({
    config,
    session,
    sync,
    accounts,
    nativeProviders,
    skills: skillManager,
    host,
    api,
    preferencesStore,
    defaults,
    hostVersion,
  })
  const page = createPageServer({
    config,
    session,
    sync,
    accounts,
    skills: skillManager,
    control,
    skillManager,
    api,
    host,
    defaults,
    preferencesStore,
    hostVersion,
  })

  let hooks = null
  const runtime = {
    config,
    dataDir,
    api,
    accounts,
    nativeProviders,
    session,
    credentials,
    host,
    sync,
    skillManager,
    defaults,
    page,
    hooks,
    control,
    attachInput(nextInput) {
      const directory = hostDirectory(nextInput)
      if (directory !== input.directory) throw new Error("Magpie changed input.directory while the plugin host was running")
      if (nextInput.client) runtime.client = nextInput.client
    },
    async start() {
      try {
        await page.start()
      } catch (error) {
        runtime.serviceError = String(error?.code || "SERVICE_START_FAILED")
        // The page cannot diagnose a service that never bound; say why on the
        // host's stderr so operators see EADDRINUSE and friends instead of a
        // page that silently keeps retrying.
        console.error(
          "novaflow-magpie-plugins: page service failed to start: " + (error?.message || error),
        )
      }
    },
    async stop() {
      sync.stop()
      await page.stop()
    },
  }
  singleton = runtime
  runtime.client = input.client
  hooks = createNovaFlowProvider({
    client: input.client,
    config,
    api,
    session,
    accounts,
    control,
    credentials,
    sync,
    hostVersion,
    report: (event, details) => {
      if (process.env.NOVAFLOW_PLUGIN_DIAGNOSTICS === "1") {
        console.error("novaflow-magpie-plugins: " + JSON.stringify({ event, ...details }))
      }
    },
  })
  runtime.hooks = hooks
  session.onChange((projection, reason) => {
    if (projection.status !== "authenticated" || reason === "account-switch" || reason === "login" || reason === "credentials-cleared") {
      accounts.disposeOwnedOnly()
      skillManager.storeCatalog = null
      skillManager.catalogProjection = []
      skillManager.persist()
      sync.resetSession()
    }
    if (projection.status === "authenticated") {
      if (reason === "account-switch" || reason === "login") {
        void nativeProviders.clearForeign().catch(() => { runtime.nativeCleanupFailed = true })
      }
      sync.start()
      return
    }
    sync.stop("NovaFlow session is no longer usable")
    void nativeProviders.clear().catch(() => { runtime.nativeCleanupFailed = true })
  })
  // Retire only the old account placeholder, never native per-Key connections.
  const legacyEntryRemoved = await nativeProviders.retireLegacyEntry()
  const migrationStore = new JsonStore(`${dataDir}/page-login-migration.json`, {})
  if (!migrationStore.read().hostAuthRetired && (legacyEntryRemoved || session.internalAuth()) && input.client?.auth?.remove) {
    try {
      await input.client.auth.remove({ path: { id: "novaflow" } })
      migrationStore.write({ hostAuthRetired: true })
    } catch { runtime.legacyAuthCleanupPending = true }
  }
  // Loading a saved session does not emit a login event. Resume polling on
  // restart too; every sync still revalidates identity with NovaFlow.
  if (session.internalAuth()) {
    await nativeProviders.clearForeign()
    sync.start()
  } else if (Object.keys(nativeProviders.store.read().entries || {}).length) {
    await nativeProviders.clear()
  }
  // The stock plugin page owns login through this protected loopback service.
  if (process.env.NOVAFLOW_PLUGIN_DISABLE_SERVICE !== "1") void runtime.start()
  return runtime
}

export async function resetRuntimeForTest() {
  if (!singleton) return
  await singleton.stop()
  singleton = null
}
