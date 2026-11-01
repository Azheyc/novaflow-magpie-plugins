export const PLUGIN_ID = "novaflow"
export const PLUGIN_VERSION = "1.5.16"
export const PRODUCTION_ORIGIN = "https://www.ycnovaflow.vip"
export const PRODUCTION_ORIGIN_ALIASES = Object.freeze([
  PRODUCTION_ORIGIN,
  "https://ycnovaflow.vip",
])
export const SERVICE_HOST = "127.0.0.1"
export const SERVICE_PORT = 3488
export const HOST_MIN_VERSION = "0.1.2058"
export const HOST_API_EVIDENCE = Object.freeze({
  version: HOST_MIN_VERSION,
  tag: "v0.1.2058",
  tagObject: "10658173d0f3266f10e78d39b66b522371b767b5",
  commit: "2d11cde056d6307f74b2b4318430d80bb394517d",
  pageService: "magpie.page.service",
  webServiceBridge: "magpie.service",
})

export function createRuntimeConfig() {
  return Object.freeze({
    pluginId: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    origin: PRODUCTION_ORIGIN,
    hostMinVersion: HOST_MIN_VERSION,
    serviceHost: SERVICE_HOST,
    servicePort: SERVICE_PORT,
    apiPrefix: "/api/novaflow/v1/plugin",
    pollingMs: 60_000,
    pollingJitter: 0.2,
    retryMaxMs: 5 * 60_000,
    requestTimeoutMs: 15_000,
    maxResponseBytes: 8 << 20,
    maxSkillBytes: 16 << 20,
    maxExpandedSkillBytes: 64 << 20,
    maxSkillFiles: 2_000,
  })
}

export const PRODUCTION_CONFIG = createRuntimeConfig()

export function compareVersions(a, b) {
  const parse = (value) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

export function assertSupportedHost(version) {
  if (compareVersions(version, HOST_MIN_VERSION) < 0) {
    throw new Error(`Magpie ${HOST_MIN_VERSION} or newer is required`)
  }
}

export function sameOrigin(value, expected) {
  try {
    return new URL(value).origin === new URL(expected).origin
  } catch {
    return false
  }
}
