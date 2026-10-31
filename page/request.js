// Classic script: Magpie's opaque sandbox cannot import cross-origin modules.
globalThis.createNovaFlowPageRequest = ({ token, fetch: send = globalThis.fetch, location: page = globalThis.location, now = Date.now }) => {
  let reconnecting = false
  const recoveryParam = "nf_page_recovered_at"
  return async function request(path, body) {
    if (reconnecting) throw new Error("本机服务已更新，正在重新连接…")
    const response = await send(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-novaflow-page-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 403 && (result.code === "PAGE_TOKEN_INVALID" || result.error === "Missing page command token")) {
        if (reconnecting) throw new Error("本机服务已更新，正在重新连接…")
        const url = new URL(page.href)
        const last = Number(url.searchParams.get(recoveryParam))
        const timestamp = now()
        // Persist only the last recovery time in the current URL. Sandbox
        // storage is unavailable; never put command or login tokens here.
        if (!last || timestamp - last >= 60_000) {
          reconnecting = true
          url.searchParams.set(recoveryParam, String(timestamp))
          page.replace(url.href)
          throw new Error("本机服务已更新，正在重新连接…")
        }
        throw new Error("页面连接未恢复，请关闭并重新打开 NovaFlow 插件页。无需退出账户。")
      }
      throw Object.assign(new Error(result.error || "操作失败，请重试"), { code: result.code || "", requestId: result.requestId || "" })
    }
    return result
  }
}
