// This file also runs as a classic script inside Magpie's opaque sandbox.
// Keep it dependency-free so static assets never need cross-origin credentials.
globalThis.NovaFlowStore = (() => {
  const list = (value) => Array.isArray(value) ? value : []
  const text = (value) => String(value ?? "")
  const enterprise = (state) => state?.session?.accountMode === "enterprise"
  const companyVisible = (state) => enterprise(state) && state?.session?.capabilities?.company_skills === true

  function localSkills(value) {
    const source = Array.isArray(value) ? value : Array.isArray(value?.skills) ? value.skills : value?.skills?.skills
    if (!Array.isArray(source)) throw new Error("Magpie 本机技能列表格式异常")
    const seen = new Set()
    return source.filter((item) => {
      if (!item || !text(item.name).trim() || seen.has(item.name)) return false
      seen.add(item.name)
      return true
    }).map((item) => ({ ...item, name: text(item.name), agents: list(item.agents).map(text) }))
  }

  function items(state) {
    if (!companyVisible(state)) return []
    return list(state?.skills?.store?.company).filter((item) => !item.status || item.status === "published").map((item) => ({ ...item, source_kind: "company" }))
  }

  function retainedItems(state) {
    if (!companyVisible(state)) return []
    const current = items(state)
    return list(state?.skills?.entries).filter((entry) => !current.some((item) => text(item.skill_id) === text(entry.skillId) && item.source_kind === (entry.sourceKind || "company"))).map((entry) => ({
      skill_id: entry.skillId, source_kind: entry.sourceKind || "company", slug: entry.slug,
      display_name: entry.displayName || entry.slug || entry.alias, description: entry.description,
      publisher: entry.publisher, category_id: entry.categoryId, category_name: entry.categoryName,
      current_version: entry.version, unavailable: true,
    }))
  }

  function categoryName(item, state) {
    const category = list(state?.skills?.store?.categories).find((value) => text(value.id) === text(item.category_id))
    return text(category?.name || item.category_name || "未分类")
  }

  function categories(state) {
    const result = [{ id: "all", name: "全部分类" }], seen = new Set()
    const add = (id, name) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      result.push({ id: `category:${id}`, name: text(name || "未命名分类") })
    }
    for (const item of [...(companyVisible(state) ? list(state?.skills?.store?.categories) : [])].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))) {
      add(text(item.id), item.name)
    }
    const company = items(state)
    for (const item of company) if (item.category_id) add(text(item.category_id), item.category_name)
    if (company.some((item) => !item.category_id)) result.push({ id: "uncategorized", name: "未分类" })
    return result
  }

  function installation(item, state, local) {
    const entry = list(state?.skills?.entries).find((value) => text(value.skillId) === text(item.skill_id) && (value.sourceKind || "company") === item.source_kind)
    const registered = entry?.registration === "registered"
    const isInstalled = registered && Array.isArray(local) && local.some((value) => value.name === entry.alias)
    return {
      entry,
      isInstalled,
      unknown: registered && !Array.isArray(local),
      downloaded: entry?.download === "installed" && !isInstalled,
      updateAvailable: !item.unavailable && isInstalled && Number(entry.version) < Number(item.current_version),
    }
  }

  function matchesCategory(item, category) {
    if (category === "all") return true
    if (category === "uncategorized") return !item.category_id
    return category === `category:${text(item.category_id)}`
  }

  function filterItems(state, local, { category = "all", installation: selection = "all", query = "" } = {}) {
    const search = text(query).trim().toLocaleLowerCase()
    const available = items(state)
    const source = selection === "installed" ? [...available, ...retainedItems(state)] : available
    return source.filter((item) => {
      const status = installation(item, state, local)
      if (!matchesCategory(item, category) || selection === "installed" && !status.isInstalled || selection === "uninstalled" && (status.isInstalled || status.unknown)) return false
      return [item.display_name, item.description, item.publisher, categoryName(item, state), ...list(item.tags)].map(text).join(" ").toLocaleLowerCase().includes(search)
    })
  }

  function otherLocalSkills(state, local, query = "") {
    if (!companyVisible(state)) return []
    const registered = new Set([...items(state), ...retainedItems(state)].map((item) => installation(item, state, local)).filter((value) => value.isInstalled).map((value) => value.entry.alias))
    const search = text(query).trim().toLocaleLowerCase()
    return list(local).filter((item) => !registered.has(item.name) && [item.name, ...list(item.agents)].join(" ").toLocaleLowerCase().includes(search))
  }

  function syncLabel(state) {
    const value = state?.sync || {}
    if (value.stale || value.status === "stale") return "使用上次同步结果"
    return ({ ready: "已同步", partial: "部分同步失败", syncing: "正在同步", refreshing: "正在更新", failed: "同步失败", error: "同步失败", wait_connection: "等待连接" })[value.status] || "等待同步"
  }

  return { enterprise, companyVisible, localSkills, items, retainedItems, categoryName, categories, installation, filterItems, otherLocalSkills, syncLabel }
})()
