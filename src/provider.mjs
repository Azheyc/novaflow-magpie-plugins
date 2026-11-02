import { assertSupportedHost } from "./config.mjs"

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

// The package runs a page service only; native per-Key providers own models.
// Do not register an account-only provider with an empty model catalog.
export function createNovaFlowProvider({ config, hostVersion = config.hostMinVersion }) {
  assertSupportedHost(hostVersion)
  return {}
}

export { usageConversion }
