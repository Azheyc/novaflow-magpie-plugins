import { assertSupportedHost } from "./config.mjs"
import { NativeAccountAuth } from "./native-auth.mjs"

function usageConversion(value) {
  if (!value || typeof value !== "object") return { error: "NovaFlow usage is unavailable", windows: [] }
  const mode = value.account_mode
  if (mode !== "personal" && mode !== "enterprise") return { error: "NovaFlow identity mode is unavailable", windows: [] }
  const unit = typeof value.unit === "string" && value.unit ? value.unit : ""
  const amount = (number) => {
    const text = number === null || number === undefined ? "unknown" : String(number)
    return text === "unknown" ? text : `${text}${unit ? " " + unit : " (unit unknown)"}`
  }
  const windows = []
  if (value.limits) {
    for (const [name, period] of [["Daily", "daily"], ["Monthly", "monthly"]]) {
      if (value.limits[`${period}_mode`] !== "limited") continue
      const limit = Number(value.limits[`${period}_limit`])
      const used = Number(value.limits[`${period}_used`])
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) {
        windows.push({
          name,
          used: Math.max(0, (used / limit) * 100),
          display: `${amount(value.limits[`${period}_used`])} / ${amount(value.limits[`${period}_limit`])}`,
          aside: false,
        })
      }
    }
  }
  const wallet = mode === "enterprise" ? value.company : value.personal
  return {
    plan: mode === "enterprise" ? "NovaFlow Enterprise" : "NovaFlow Personal",
    user: value.display_name || "",
    balance: amount(wallet?.available),
    windows,
  }
}

// This provider is an account/control entry only. Native Magpie providers
// own model discovery and inference; no fetch or model transformation hooks.
export function createNovaFlowProvider({ config, api, session, sync, control, hostVersion = config.hostMinVersion }) {
  assertSupportedHost(hostVersion)
  const nativeAuth = new NativeAccountAuth({ api })
  return {
    auth: {
      provider: "novaflow",
      single: true,
      methods: [{
        type: "api",
        label: "使用 NovaFlow 插件连接密钥登录",
        keyless: true,
        async ask(inputs) { return nativeAuth.nextPrompt(inputs) },
        async authorize(inputs) {
          const result = await nativeAuth.authorize(inputs)
          try {
            const { bootstrap } = await session.acceptLogin(result)
            // Native discovery may take longer than the host's login budget.
            // Session acceptance starts polling; discovery continues in the background.
            void sync.syncNow("login").catch(() => {})
            return {
              ...result,
              accountId: String(bootstrap.display_name || bootstrap.user_id || "NovaFlow"),
              uid: String(bootstrap.user_id || ""),
              accountMode: bootstrap.account_mode,
            }
          } catch (error) {
            nativeAuth.clear()
            throw error
          }
        },
      }],
      ...(control ? { native: control } : {}),
      refreshLead: 5 * 60_000,
      async refresh(auth) {
        await session.activateAuth(auth)
        await session.ensureFresh({ force: true })
        const next = session.internalAuth()
        if (!next) throw Object.assign(new Error("NovaFlow sign-in expired"), { signIn: "expired" })
        return { access: next.access, refresh: next.refresh, expires: next.expiresAt }
      },
      async loader(getAuth) {
        await session.activateAuth(await getAuth())
        // A connection key authorizes sync only, never model inference.
        return { apiKey: "" }
      },
      async usage(getAuth) {
        try {
          await session.activateAuth(await getAuth())
          const owner = session.ownership?.()
          const value = await session.withAccess(access => api.usage(access))
          const bootstrap = await session.withAccess(access => api.bootstrap(access))
          session.assertOwnership?.(owner)
          await session.updateBootstrap(bootstrap, { owner })
          return usageConversion({ ...value, display_name: bootstrap.display_name, account_mode: value.account_mode ?? bootstrap.account_mode })
        } catch (error) {
          return { error: String(error?.message ?? error), windows: [], ...(error.signIn ? { signIn: error.signIn } : {}) }
        }
      },
    },
    provider: {
      id: "novaflow",
      name: "NovaFlow",
      async models(_provider, { auth } = {}) {
        await session.activateAuth(auth)
        return {}
      },
    },
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider.novaflow = { ...(cfg.provider.novaflow ?? {}), name: "NovaFlow" }
    },
  }
}

export { usageConversion }
