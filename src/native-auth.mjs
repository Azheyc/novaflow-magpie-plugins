function clean(value) {
  return String(value ?? "").trim()
}

export function connectionCredentials(value) {
  const key = clean(value)
  if (!key.startsWith("nfpc_") || key.length < 37 || key.length > 512 || /\s/.test(key)) {
    throw Object.assign(new Error("NovaFlow 插件连接密钥格式不正确"), { code: "PLUGIN_CONNECTION_KEY_INVALID" })
  }
  return { access: key, refresh: key, expires: Number.MAX_SAFE_INTEGER }
}
