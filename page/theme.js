// Magpie 0.1.2058 pagebridge.js / assets/pluginpages.js theme protocol.
// The local-service navigation keeps the same sandbox WindowProxy, so its
// document must say hello again to receive the official theme and updates.
// This adapter reads the theme only; it never asks for options or host APIs.
(() => {
  const tokens = ["bg", "card", "fg", "fg-2", "muted", "faint", "line", "accent", "accent-soft", "accent-fg", "green", "red", "amber", "font", "code"]
  const root = document.documentElement
  function paint(theme) {
    if (!theme || typeof theme.dark !== "boolean" || !theme.tokens || typeof theme.tokens !== "object" || Array.isArray(theme.tokens)) return
    root.dataset.theme = theme.dark ? "dark" : "light"
    root.style.colorScheme = theme.dark ? "dark" : "light"
    for (const name of tokens) {
      const value = theme.tokens[name]
      if (typeof value === "string" && value.trim() && value.length <= 1024) root.style.setProperty("--magpie-" + name, value)
      else root.style.removeProperty("--magpie-" + name)
    }
  }
  // On the initial package page the official bridge is already available.
  if (window.magpie?.ready && typeof window.magpie.onTheme === "function") {
    window.magpie.onTheme(paint)
    Promise.resolve(window.magpie.ready).then(paint).catch(() => {})
    return
  }
  // A separately opened local page uses the stylesheet's system fallback.
  if (window.parent === window) return
  const helloId = "novaflow-theme-hello"
  addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || message.magpie !== 1) return
    if (message.event === "theme") paint(message.data)
    else if (message.id === helloId && !message.error) paint(message.result)
  })
  window.parent.postMessage({ magpie: 1, id: helloId, method: "hello" }, "*")
})()
