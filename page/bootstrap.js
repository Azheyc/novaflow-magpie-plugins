(() => {
  const status = document.getElementById("status")
  const fallback = document.getElementById("fallback")
  magpie.ready.then(() => {
    const target = new URL(magpie.service || "http://127.0.0.1:3488/", location.href)
    const loopback = target.origin === "http://127.0.0.1:3488"
    if (!/^https?:$/.test(target.protocol) || (!magpie.service && !loopback)) throw new Error("unexpected service")
    location.replace(target.href)
  }).catch(() => {
    status.textContent = "本机服务暂未就绪。请确认 Magpie 0.1.2058 或更新版本，并重开此页面。"
    fallback.hidden = false
  })
})()
