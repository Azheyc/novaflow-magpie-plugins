function clean(value) {
  return String(value ?? "").trim()
}

export class NativeAccountAuth {
  constructor({ api } = {}) {
    if (!api) throw new Error("NativeAccountAuth requires an API client")
    this.api = api
    this.pending = ""
  }

  async nextPrompt(inputs = {}) {
    const key = clean(inputs.connection_key)
    if (!key) {
      return {
        type: "password",
        key: "connection_key",
        message: "NovaFlow 插件连接密钥",
        placeholder: "粘贴从 NovaFlow 账户页创建的连接密钥",
      }
    }
    if (!key.startsWith("nfpc_") || key.length < 37) {
      throw Object.assign(new Error("NovaFlow 插件连接密钥格式不正确"), { code: "PLUGIN_CONNECTION_KEY_INVALID" })
    }
    await this.api.validateConnectionKey(key)
    this.pending = key
    return null
  }

  async authorize(inputs = {}) {
    const key = clean(inputs.connection_key)
    if (!key || key !== this.pending) {
      this.pending = ""
      throw Object.assign(new Error("NovaFlow 连接密钥验证已过期，请重新粘贴"), { code: "PLUGIN_CONNECTION_KEY_INVALID" })
    }
    this.pending = ""
    // Magpie stores these fields in the provider's protected account record.
    // The server credential itself is long-lived until its configured expiry
    // or explicit revocation; refresh simply validates it again.
    return {
      type: "success",
      access: key,
      refresh: key,
      expires: Number.MAX_SAFE_INTEGER,
    }
  }

  clear() {
    this.pending = ""
  }
}
