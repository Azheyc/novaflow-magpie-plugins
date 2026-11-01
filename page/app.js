const token = document.querySelector('meta[name="novaflow-page-token"]').content
const root = document.getElementById("app")
const dialog = document.getElementById("detail")
const storeModel = globalThis.NovaFlowStore
let state = null, busy = false, loading = false, resourceLoading = false
let local = null, localError = "", storeError = "", pageError = ""
let accountKey = "", resourcesFor = "", resourcesAt = 0, revision = 0, toastTimer, dialogVersion = 0
let category = "all", installationFilter = "all", query = ""
let shareDraft = null
let backdropPressed = false

function el(tag, cls = "", text = "") {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = String(text ?? "")
  return node
}

function button(text, action, cls = "") {
  const node = el("button", `text ${cls}`, text)
  node.type = "button"
  node.dataset.lock = "true"
  node.disabled = busy || resourceLoading
  node.onclick = action
  return node
}

function enterpriseOnly(node, allowed = storeModel.companyVisible(state)) {
  if (!allowed) {
    node.dataset.unavailable = "true"
    node.disabled = true
    node.title = "企业用户才可使用，开通或加入企业后即可使用"
    node.setAttribute("aria-disabled", "true")
  }
  return node
}

function enterpriseGuide() {
  const body = el("div")
  body.append(el("p", "", "企业用户可使用公司技能商店、安装更新、本机技能与技能分享。"))
  const steps = el("ol", "login-steps")
  steps.append(el("li", "", "打开 NovaFlow 平台并登录，进入个人资料。"), el("li", "", "自行开通：选择创建企业，填写企业名称并按页面确认。"), el("li", "", "加入已有企业：向企业管理员获取企业注册码，在个人资料中选择加入企业。"), el("li", "", "完成后回到插件，点击立即同步；若身份尚未更新，请重新连接账户。"))
  body.append(steps, button("前往平台个人资料", () => command("enterprise-guide").catch(error => toast(error.message)), "primary"))
  modal("开通企业账号指引", body)
}

function toast(message) {
  const node = document.getElementById("toast")
  clearTimeout(toastTimer)
  node.textContent = message
  node.classList.add("visible")
  toastTimer = setTimeout(() => node.classList.remove("visible"), 5000)
}

const request = globalThis.createNovaFlowPageRequest({ token })

function command(operation, payload = {}) {
  return request("api/command", { operation, payload })
}

function identity(value) {
  const session = value?.session || {}
  return [session.status, session.userId, session.accountMode, session.company?.id].join(":")
}

function acceptState(value) {
  if (!value?.session) return
  const nextKey = identity(value)
  if (nextKey !== accountKey) {
    accountKey = nextKey
    resourcesFor = ""
    resourcesAt = 0
    local = null
    localError = storeError = ""
    shareDraft = null
    category = "all"
    installationFilter = "all"
    dialogVersion++
    if (dialog.open) dialog.close()
  }
  state = value
}

function lockControls() {
  root.setAttribute("aria-busy", String(busy || loading || resourceLoading))
  for (const node of document.querySelectorAll("[data-lock]")) {
    node.disabled = busy || resourceLoading || node.dataset.unavailable === "true"
  }
}

function acceptLocal(result) {
  if (result.libraryAvailable === false || result.skills?.libraryAvailable === false) throw new Error("Magpie 本机资源库暂不可用")
  local = storeModel.localSkills(result)
  localError = ""
}

async function readLocal() {
  try { acceptLocal(await command("local-skills")); return true }
  catch (error) { local = null; localError = error.message; return false }
}

async function run(operation, payload = {}, message = "已完成", after, onError) {
  if (busy || resourceLoading) return null
  busy = true
  revision++
  render()
  try {
    const result = await command(operation, payload)
    acceptState(result.state || (result.session ? result : await command("status")))
    if (after) await after(result)
    if (message) toast(message)
    return result
  } catch (error) {
    if (operation === "install-store-skill") {
      try { acceptState(await command("status")) } catch {}
      await readLocal()
    }
    toast(error.message)
    if (onError) onError(error)
    return null
  } finally {
    busy = false
    render()
  }
}

function row(title, value, control) {
  const node = el("div", "row"), text = el("div", "who")
  text.append(el("h3", "", title), el("p", "", value))
  node.append(text)
  if (control) node.append(control)
  return node
}

function closeDialog() { backdropPressed = false; dialogVersion++; dialog.close() }

function modal(title, body) {
  const top = el("div", "dialog-heading"), close = button("关闭", closeDialog, "quiet")
  delete close.dataset.lock
  close.disabled = false
  top.append(el("h2", "", title), close)
  const content = el("div", "dialog-content")
  content.append(body)
  dialog.replaceChildren(top, content)
  backdropPressed = false
  if (!dialog.open) dialog.showModal()
  return ++dialogVersion
}

function roleLabel(session) {
  if (!storeModel.enterprise(state)) return session.role === "platform_admin" ? "平台管理员 · 个人账户" : "个人账户"
  return session.role === "company_admin" ? "公司管理员" : "员工"
}

function timeLabel(value) {
  if (!value) return "尚未完成首次同步"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "同步时间暂不可用" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function renderHeader() {
  const session = state.session || {}, header = el("header", "page-header"), who = el("div", "identity"), name = el("div")
  name.append(el("h1", "", "NovaFlow"), el("p", "identity-subtitle", "技能与配置初始化"))
  const mark = el("img", "brand-icon")
  mark.src = "logo.png"
  mark.alt = ""
  who.append(mark, name)
  header.append(who)
  if (session.status === "authenticated") {
    const account = el("div", "account-summary"), text = el("div", "account-text")
    text.append(el("strong", "", session.displayName || "已连接 NovaFlow"), el("small", "muted", [roleLabel(session), ...(storeModel.enterprise(state) && session.company?.displayName ? [session.company.displayName] : [])].join(" · ")))
    account.append(el("span", "connection-dot"), text, button("退出登录", confirmLogout, "quiet"))
    header.append(account)
  }
  root.append(header)
}

function renderSummary() {
  const sync = state.sync || {}, summary = el("section", "sync-summary"), text = el("div", "summary-main"), detail = el("div", "summary-detail")
  text.append(el("span", `status-dot ${sync.status === "ready" && !sync.stale ? "ready" : ""}`), el("strong", "", busy ? "正在处理…" : storeModel.syncLabel(state)))
  const localLink = button(`本机已安装 ${Array.isArray(local) ? local.length : "—"}`, () => {
    category = "all"
    installationFilter = "installed"
    query = ""
    render()
    document.querySelector(".store")?.scrollIntoView({ block: "start", behavior: "smooth" })
  }, "local-link")
  delete localLink.dataset.lock
  enterpriseOnly(localLink)
  detail.append(el("span", "", `${state.accounts?.routeCount || 0} 个可用模型`), localLink, el("span", "summary-time", sync.lastSuccessAt ? `上次同步 ${timeLabel(sync.lastSuccessAt)}` : timeLabel("")))
  text.append(detail)
  summary.append(text, button("立即同步", syncNow, "sync-action"))
  root.append(summary)
  if (pageError) root.append(el("p", "inline-error", `状态刷新失败：${pageError}。当前显示上次读取结果。`))
}

function installButton(item) {
  const status = storeModel.installation(item, state, local), sourceAllowed = state.session.capabilities?.[item.source_kind === "company" ? "company_skills" : "platform_skills"] === true
  const label = item.unavailable ? "本机副本" : status.updateAvailable ? "更新" : status.isInstalled ? "已安装" : status.unknown ? "待确认" : status.downloaded ? "重试登记" : "安装"
  const node = button(label, () => installSkill(item), `install-button pm-go pm-act ${status.isInstalled && !status.updateAvailable ? "installed done" : "get"}`)
  if (item.unavailable || status.isInstalled && !status.updateAvailable || status.unknown || !sourceAllowed) {
    node.dataset.unavailable = "true"
    node.disabled = true
  }
  node.setAttribute("aria-label", `${label} ${item.display_name || item.slug || "技能"}`)
  if (status.unknown) node.title = "无法读取本机资源库，刷新后确认安装状态"
  return node
}

async function installSkill(item) {
  const status = storeModel.installation(item, state, local)
  if (status.isInstalled && !status.updateAvailable || status.unknown) return
  await run("install-store-skill", { sourceKind: item.source_kind, skillId: item.skill_id, targetAgents: [] }, null, async () => {
    const verified = await readLocal(), installed = storeModel.installation(item, state, local)
    if (verified && installed.isInstalled && !installed.updateAvailable) { closeDialog(); toast("已登记到 Magpie 资源库，可在 Agent 中按需使用") }
    else if (!verified) toast("安装命令已返回，本机登记状态未能确认，请刷新本机状态")
    else toast("技能尚未完成本机登记，请重试；未确认安装成功")
  })
}

function skillCard(item) {
  const card = el("article", "skill-card pm-card"), top = el("div", "card-top pm-top"), who = el("div", "who pm-who"), title = el("div", "pm-name"), publisher = el("div", "publisher pm-by")
  title.append(el("b", "", item.display_name || item.slug || "未命名技能"))
  publisher.append(el("span", "", item.publisher || (item.source_kind === "platform" ? "NovaFlow" : "公司成员")))
  who.append(title, publisher)
  const icon = el("div", "skill-icon pm-logo", String(item.display_name || item.slug || "S").slice(0, 1))
  const install = installButton(item), action = install.onclick
  install.onclick = (event) => { event.stopPropagation(); action(event) }
  top.append(icon, who, install)
  const meta = el("div", "card-meta pm-meta")
  meta.append(el("span", "category-label pm-chip kind pv", storeModel.categoryName(item, state)), el("span", "version pm-ver", `v${item.current_version ?? "—"}`))
  if (item.file_count != null && Number.isFinite(Number(item.file_count))) meta.append(el("span", "file-count", `${item.file_count} 个文件`))
  card.append(top, el("p", "skill-description pm-sum", item.description || "发布者暂未添加技能说明。"), meta)
  if (item.unavailable) card.append(el("p", "muted", "远端已不可下载或更新，保留本机副本。"))
  card.tabIndex = 0
  card.setAttribute("role", "button")
  card.setAttribute("aria-label", `${item.display_name || item.slug}，查看技能详情`)
  card.onclick = () => item.unavailable ? toast("远端已不可下载或更新，本机副本及登记继续保留。") : detail(item)
  card.onkeydown = (event) => {
    if (event.target === card && ["Enter", " "].includes(event.key)) { event.preventDefault(); item.unavailable ? toast("远端已不可下载或更新，本机副本及登记继续保留。") : void detail(item) }
  }
  return card
}

function renderStore() {
  const section = el("section", "store"), heading = el("div", "section-heading"), text = el("div"), actions = el("div", "actions")
  text.append(el("h2", "", "公司技能商店"), el("p", "", "按公司分类查找技能，按需手动安装或更新。"))
  actions.append(enterpriseOnly(button(resourceLoading ? "正在刷新…" : "刷新", () => refreshResources(true), "quiet")))
  actions.append(enterpriseOnly(button("＋ 分享技能", sharePicker, "primary"), canContribute()))
  heading.append(text, actions)
  section.append(heading)
  const chips = el("div", "category-chips segs"), results = el("div", "store-results"), categories = storeModel.categories(state)
  chips.setAttribute("role", "group")
  chips.setAttribute("aria-label", "技能分类")
  if (!categories.some((value) => value.id === category)) category = "all"
  for (const option of categories) {
    const node = button(option.name, () => {
      category = option.id
      for (const child of chips.children) {
        const selected = child.dataset.category === category
        child.classList.toggle("active", selected)
        child.classList.toggle("on", selected)
        child.setAttribute("aria-pressed", String(selected))
      }
      draw()
    }, `category-chip opt ${category === option.id ? "active on" : ""}`)
    node.dataset.category = option.id
    delete node.dataset.lock
    enterpriseOnly(node)
    node.setAttribute("aria-pressed", String(category === option.id))
    chips.append(node)
  }
  const tools = el("div", "store-toolbar pm-ghbar"), filters = el("div", "installation-filters segs"), searchWrap = el("label", "search-box pm-find pm-ghfind"), search = el("input")
  filters.setAttribute("role", "group")
  filters.setAttribute("aria-label", "安装状态")
  for (const [id, label] of [["all", "全部"], ["installed", "已安装"], ["uninstalled", "未安装"]]) {
    const node = button(label, () => {
      installationFilter = id
      for (const child of filters.children) {
        const selected = child.dataset.filter === id
        child.classList.toggle("active", selected)
        child.classList.toggle("on", selected)
        child.setAttribute("aria-pressed", String(selected))
      }
      draw()
    }, `opt ${installationFilter === id ? "active on" : ""}`)
    delete node.dataset.lock
    enterpriseOnly(node)
    node.dataset.filter = id
    node.setAttribute("aria-pressed", String(installationFilter === id))
    filters.append(node)
  }
  search.id = "skill-search"
  search.type = "search"
  search.placeholder = "搜索技能、发布者或关键词"
  search.setAttribute("aria-label", "搜索技能")
  search.value = query
  enterpriseOnly(search)
  search.oninput = () => { query = search.value; draw() }
  const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  searchIcon.setAttribute("width", "14"); searchIcon.setAttribute("height", "14"); searchIcon.setAttribute("viewBox", "0 0 24 24"); searchIcon.setAttribute("fill", "none"); searchIcon.setAttribute("stroke", "currentColor"); searchIcon.setAttribute("stroke-width", "1.6"); searchIcon.setAttribute("aria-hidden", "true")
  const lens = document.createElementNS("http://www.w3.org/2000/svg", "circle"), handle = document.createElementNS("http://www.w3.org/2000/svg", "path")
  lens.setAttribute("cx", "10.5"); lens.setAttribute("cy", "10.5"); lens.setAttribute("r", "6.5"); handle.setAttribute("d", "m16 16 4 4")
  searchIcon.append(lens, handle)
  searchWrap.append(searchIcon, search)
  tools.append(chips, filters, searchWrap)
  section.append(tools)
  if (storeError) section.append(el("p", "inline-error", `技能商店读取失败：${storeError}。请点击刷新重试。`))
  if (localError) section.append(el("p", "inline-error", `本机技能读取失败：${localError}。安装计数暂不可用。`))
  section.append(results)
  root.append(section)
  function draw() {
    results.replaceChildren()
    if (!storeModel.companyVisible(state)) {
      const locked = el("div", "empty enterprise-gate")
      locked.append(el("div", "empty-icon", "◇"), el("h3", "", "企业用户才可使用"), el("p", "", "开通或加入企业后，即可使用技能商店、本机技能、安装更新和分享功能。账户同步和配置初始化可继续使用。"), button("开通企业账号指引", enterpriseGuide, "primary"))
      results.append(locked)
      return
    }
    const matched = storeModel.filterItems(state, local, { category, installation: installationFilter, query })
    let count = 0
    for (const [source, label] of [["company", `${state.session.company?.displayName || "公司"}技能`], ["platform", "保留的平台技能副本"]]) {
      const list = matched.filter((item) => item.source_kind === source)
      if (!list.length) continue
      const group = el("section", "skill-group pm-sec"), grid = el("div", "skill-grid pm-grid"), caption = el("div", "group-heading pm-sechead")
      caption.append(el("h3", "", label), el("span", "muted", `${list.length} 项`))
      group.append(caption)
      for (const item of list) grid.append(skillCard(item))
      group.append(grid)
      results.append(group)
      count += list.length
    }
    if (category === "all" && installationFilter === "installed") {
      const other = storeModel.otherLocalSkills(state, local, query)
      if (other.length) {
        const group = el("section", "skill-group pm-sec"), heading = el("div", "group-heading pm-sechead"), grid = el("div", "skill-grid pm-grid")
        heading.append(el("h3", "", "本机其他技能"), el("span", "muted", `${other.length} 项`))
        group.append(heading)
        for (const skill of other) {
          const card = el("article", "skill-card pm-card local-card"), top = el("div", "card-top pm-top"), text = el("div", "who pm-who"), name = el("div", "pm-name"), publisher = el("div", "publisher pm-by")
          name.append(el("b", "", skill.name)); publisher.append(el("span", "", "Magpie 本机资源库"))
          text.append(name, publisher)
          top.append(el("div", "skill-icon pm-logo", skill.name.slice(0, 1).toUpperCase()), text, el("span", "local-installed pm-chip", "已安装"))
          card.append(top, el("p", "skill-description pm-sum", skill.agents.length ? `已关联 Agent：${skill.agents.join("、")}` : "暂未关联 Agent，可在 Magpie 资源库选择使用。"))
          const meta = el("div", "card-meta pm-meta")
          meta.append(el("span", "category-label pm-chip kind", "本机技能"))
          if (canContribute()) meta.append(button("分享到公司", () => share(skill), "text-action"))
          card.append(meta)
          grid.append(card)
        }
        group.append(grid)
        results.append(group)
        count += other.length
      }
    }
    if (!count) {
      let title = "暂无匹配技能", description = "试试其他分类或搜索词。"
      if (!state.skills?.store && resourceLoading) { title = "正在加载技能商店"; description = "正在读取公司技能与本机安装状态…" }
      else if (installationFilter === "installed" && !Array.isArray(local)) { title = "暂时无法确认本机安装状态"; description = "请刷新本机资源库后再查看已安装技能。" }
      else if (!query && category === "company") { title = "公司还没有分享技能"; description = canContribute() ? "可以从 Magpie 本机资源库选择技能，预览文件后分享。" : "公司成员分享的技能会显示在这里。" }
      else if (!query && installationFilter === "installed") { title = "本机还没有已安装技能"; description = "在商店中安装技能后，可在 Magpie 资源库查看。" }
      else if (!query && installationFilter === "uninstalled") { title = "当前没有待安装技能"; description = "可以切换分类，或在已安装中查看本机技能。" }
      else if (!query && !storeModel.items(state).length) { title = "技能商店暂未发布内容"; description = "公司成员分享的技能会在这里展示，可稍后刷新。" }
      const empty = el("div", "empty")
      empty.append(el("div", "empty-icon", "◇"), el("h3", "", title), el("p", "", description))
      results.append(empty)
    }
  }
  draw()
}

async function detail(item) {
  if (!storeModel.companyVisible(state) || busy || resourceLoading) return
  const body = el("div", "detail-body")
  body.append(el("p", "muted", "正在读取技能详情…"))
  const version = modal(item.display_name || item.slug, body), key = accountKey
  try {
    const data = await command("skill-detail", { sourceKind: item.source_kind, skillId: item.skill_id })
    if (dialogVersion !== version || accountKey !== key || !dialog.open) return
    const skill = { ...item, ...data.skill, source_kind: item.source_kind }, current = data.versions.find((value) => Number(value.version) === Number(skill.current_version))
    body.replaceChildren(el("p", "", skill.description || "暂无说明"))
    body.append(row("发布者", skill.publisher || (item.source_kind === "platform" ? "NovaFlow" : "公司成员")), row("分类", storeModel.categoryName(skill, state)), row("当前版本", `v${skill.current_version}`), row("许可", skill.license || "未填写"))
    const files = el("div", "files")
    files.append(el("h3", "", "技能包文件"))
    for (const file of current?.files || []) files.append(row(file.path, `${file.size} B`))
    body.append(files, el("p", "muted", "安装前校验包完整性，安装过程不执行技能脚本。Agent 关联使用本页已保存的本机偏好。"), installButton(skill))
  } catch (error) {
    if (dialogVersion === version && accountKey === key) body.replaceChildren(el("p", "inline-error", error.message))
  }
}

function field(title, input, hint = "") {
  const label = el("label", "field")
  label.append(el("span", "field-title", title), input)
  if (hint) label.append(el("small", "muted", hint))
  return label
}

function renderSync() {
  const sync = state.sync || {}, defaults = state.defaults || sync.defaults || {}, box = el("div", "disclosure-body")
  box.append(row("账户同步", `${storeModel.syncLabel(state)} · ${state.accounts?.routeCount || 0} 个模型路由 · ${state.accounts?.keyCount || 0} 个授权 Key`))
  if (sync.errorCode) box.append(row("同步需要处理", sync.errorCode))
  const defaultsText = defaults.status === "complete" ? "上次初始化已完成，可再次执行" : defaults.status === "partial_failure" ? "上次有未完成项，可重新初始化" : defaults.status === "running" ? "正在初始化" : "等待手动初始化"
  box.append(row("初始化状态", defaultsText), el("p", "settings-note", "每次点击并确认后，将重新检查 magpie-image 及已接管的 Agent，把生图模型设为 NovaFlow 的 gpt-image-2，更新渠道设为稳定版。此前自行修改的这两项设置会被重新设定。账户同步不执行初始化。"))
  for (const item of defaults.results || []) box.append(row(({ mcp: "生图 MCP", imageProvider: "生图连接", imageGen: "生图模型", updateChannel: "更新渠道" })[item.id] || item.id, item.message || item.status))
  const section = el("section", "disclosure config-initialization"), heading = el("div", "section-heading initialization-heading"), title = el("div")
  title.append(el("h2", "", "配置初始化"), el("p", "", "手动初始化 Magpie 设置，可重复执行"))
  heading.append(title, button("初始化配置", confirmInitialization, "primary"))
  section.append(heading, box)
  root.append(section)
}

function confirmInitialization() {
  const body = el("div")
  body.append(el("p", "", "将安装 magpie-image 并关联当前已接管的 Agent，建立独立的 NovaFlow 生图连接，生图模型选择 gpt-image-2，更新渠道设为稳定版。每次确认均重新执行，生图模型和更新渠道将覆盖为上述设置。MCP 关联会修改对应 Agent 配置，正在使用的 Agent 可能需要重新连接。"), button("确认初始化", () => run("initialize", {}, "初始化结果已更新，请查看各项状态", closeDialog), "primary"))
  modal("初始化 Magpie 配置", body)
}

function canContribute() {
  return storeModel.enterprise(state) && state?.session?.capabilities?.contribute_skills === true
}

function shareImportGuide() {
  const guide = el("section", "share-import-guide")
  guide.append(el("p", "", "只有已添加到 Magpie 资料库（资源库）的技能才可以分享。仅安装在 Agent 中、尚未导入资料库的技能不会出现在下方列表。"), el("h3", "", "如何导入技能"))
  const steps = el("ol", "login-steps")
  steps.append(
    el("li", "", "在 Magpie 左侧打开「资源库」，切换到「技能」。"),
    el("li", "", "Agent 中已有技能：在「Agent 中已有」区域找到技能，点击「导入」或「全部导入」。"),
    el("li", "", "本机文件夹：在顶部输入技能文件夹路径，点击「查找技能」，勾选后确认添加。文件夹内必须包含 SKILL.md；ZIP 请先解压。"),
    el("li", "", "导入完成后回到此处，点击「刷新技能列表」，再选择「预览并分享」。"),
  )
  guide.append(steps, button("刷新技能列表", sharePicker, "secondary"))
  return guide
}

async function sharePicker() {
  if (!canContribute() || busy || resourceLoading) return
  busy = true
  lockControls()
  const body = el("div", "share-list"), key = accountKey
  const guide = shareImportGuide()
  body.append(guide, el("p", "muted", "正在读取 Magpie 本机资源库…"))
  const version = modal("分享本机技能", body)
  await readLocal()
  busy = false
  render()
  if (accountKey !== key || dialogVersion !== version || !dialog.open) return
  body.replaceChildren(guide)
  if (localError) { body.append(el("p", "inline-error", localError)); return }
  body.append(el("p", "muted", "从已登记技能中选择，确认包文件后再分享到当前公司。"))
  for (const skill of local || []) body.append(row(skill.name, skill.agents.length ? `Agent：${skill.agents.join("、")}` : "尚未关联 Agent", button("预览并分享", () => share(skill), "secondary")))
  if (!local?.length) body.append(el("p", "empty", "资料库中暂无可分享的技能，请按上方指引导入后刷新。"))
}

async function share(skill) {
  if (!canContribute() || busy || resourceLoading) return
  busy = true
  lockControls()
  const body = el("div"), key = accountKey
  body.append(el("p", "muted", "正在读取并检查技能文件…"))
  const version = modal("预览技能文件", body)
  try {
    const preview = await command("preview-skill", { sourceName: skill.name })
    if (accountKey !== key || dialogVersion !== version || !dialog.open) return
    if (!shareDraft || shareDraft.sourceName !== skill.name) {
      shareDraft = { category_id: "", sourceName: skill.name, display_name: skill.name, description: preview.description || skill.description || "", idempotencyKey: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }
    }
    const form = el("form", "share-form")
    form.onsubmit = (event) => event.preventDefault()
    form.append(el("p", "settings-note", `分享到：${state.session.company?.displayName || "当前公司"}。请确认用途说明及将分享的文件。`))
    const companyCategory = el("select")
    companyCategory.id = "share-category"
    companyCategory.dataset.lock = "true"
    companyCategory.append(new Option("未分类", ""))
    for (const category of state.skills?.store?.categories || []) companyCategory.append(new Option(category.name, String(category.id)))
    companyCategory.value = shareDraft.category_id || ""
    companyCategory.onchange = () => { shareDraft.category_id = companyCategory.value }
    const name = el("input"), description = el("textarea")
    for (const [node, id, property] of [[name, "share-name", "display_name"], [description, "share-description", "description"]]) {
      node.id = id
      node.value = shareDraft[property]
      node.dataset.lock = "true"
      node.oninput = () => { shareDraft[property] = node.value }
    }
    name.required = true
    name.maxLength = 160
    description.maxLength = 2000
    description.rows = 3
    form.append(field("公司分类", companyCategory, "分享后立即上架，供当前公司成员手动安装。"), field("显示名称", name), field("用途说明", description, "已读取资料库中的技能说明，可按需修改。"))
    const files = el("div", "files")
    files.append(el("h3", "", `将分享 ${preview.files?.length || 0} 个文件`))
    for (const file of preview.files || []) files.append(row(file.path, `${file.size} B`))
    form.append(files)
    if (preview.excluded?.length) form.append(el("p", "muted", `已排除 ${preview.excluded.length} 项凭据、缓存或不支持的内容。`))
    const error = el("p", "inline-error")
    error.hidden = true
    error.setAttribute("role", "alert")
    form.append(error, button("确认分享到公司", async () => {
      if (busy || !form.reportValidity()) return
      error.textContent = ""
      error.hidden = true
      let failure = ""
      const result = await run("share-skill", { ...shareDraft, display_name: shareDraft.display_name.trim() }, null, null, cause => { failure = cause.message })
      if (!result) { error.textContent = `分享未完成：${failure || "请稍后重试"}。草稿已保留。`; error.hidden = false; return }
      shareDraft = null
      closeDialog()
      toast("已分享到公司")
      await refreshResources(true, false)
    }, "primary"))
    body.replaceChildren(form)
  } catch (error) {
    if (dialogVersion === version) body.replaceChildren(el("p", "inline-error", error.message))
  } finally { busy = false; render() }
}

function confirmLogout() {
  if (busy || resourceLoading) return
  const body = el("div")
  body.append(el("p", "", "退出后将移除本机 NovaFlow 登录，并注销当前会话。"), button("确认退出", () => run("logout", {}, "已退出 NovaFlow", closeDialog), "primary"))
  modal("退出 NovaFlow", body)
}

function renderLogin() {
  const box = el("section", "login-panel"), steps = el("ol", "login-steps")
  box.append(el("div", "login-symbol", "↗"), el("h2", "", "连接 NovaFlow，开始发现技能"), el("p", "", "请使用 NovaFlow 连接密钥完成连接，登录后自动读取同步状态。"))
  steps.append(el("li", "", "在 NovaFlow 官网个人资料页生成连接密钥。"), el("li", "", "在 Magpie 进入「供应商 → 添加供应商 → NovaFlow」。"), el("li", "", "输入连接密钥，连接成功后返回此页。"))
  box.append(steps, button("我已连接，刷新状态", load, "primary"))
  root.append(box)
}

function render() {
  const active = document.activeElement, focusId = root.contains(active) ? active.id : ""
  let selection = null
  if (focusId && ["INPUT", "TEXTAREA"].includes(active.tagName)) { try { selection = [active.selectionStart, active.selectionEnd] } catch {} }
  root.replaceChildren()
  if (!state) { root.append(el("p", "empty", "正在连接 NovaFlow…")); return }
  renderHeader()
  if (state.session?.status !== "authenticated") renderLogin()
  else { renderSummary(); renderStore(); renderSync() }
  lockControls()
  const restored = focusId && document.getElementById(focusId)
  if (restored) {
    restored.focus({ preventScroll: true })
    if (selection) try { restored.setSelectionRange(...selection) } catch {}
  }
}

async function refreshResources(includeStore = false, showToast = true) {
  if (busy || resourceLoading || !storeModel.companyVisible(state)) return
  resourceLoading = true
  const key = accountKey, version = revision
  render()
  const results = await Promise.allSettled([command("local-skills"), ...(includeStore && storeModel.companyVisible(state) ? [command("skill-store")] : [])])
  resourceLoading = false
  if (key !== accountKey || version !== revision) { render(); return }
  const [localResult, storeResult] = results
  if (localResult.status === "fulfilled") {
    try { acceptLocal(localResult.value) } catch (error) { local = null; localError = error.message }
  } else { local = null; localError = localResult.reason.message }
  if (storeResult?.status === "fulfilled") { acceptState(storeResult.value.state || storeResult.value); storeError = "" }
  else if (storeResult) storeError = storeResult.reason.message
  resourcesFor = key
  resourcesAt = Date.now()
  render()
  if (showToast) toast(localError || storeError ? "部分内容读取失败，请查看页面提示" : "技能商店与本机状态已刷新")
}

async function syncNow() {
  const result = await run("sync", {}, null)
  if (!result) return
  toast(state.sync?.status === "ready" && !state.sync?.stale ? "连接与模型状态已同步" : `${storeModel.syncLabel(state)}${state.sync?.errorCode ? `：${state.sync.errorCode}` : ""}`)
  await refreshResources(true, false)
}

async function load() {
  if (busy || loading || resourceLoading) return
  loading = true
  const version = revision
  try {
    const result = await request("api/state")
    if (version !== revision) return
    acceptState(result)
    pageError = ""
    render()
  } catch (error) {
    pageError = error.message
    if (state) render()
    else root.replaceChildren(el("p", "empty inline-error", `连接失败：${error.message}`), button("重试连接", load, "primary"))
  } finally { loading = false; lockControls() }
  if (storeModel.companyVisible(state) && version === revision && (resourcesFor !== accountKey || Date.now() - resourcesAt > 5 * 60_000)) {
    await refreshResources(resourcesFor !== accountKey, false)
  }
}

function onDialogBackdrop(event) {
  if (event.target !== dialog) return false
  const rect = dialog.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}

dialog.addEventListener("pointerdown", event => { backdropPressed = event.button === 0 && onDialogBackdrop(event) })
dialog.addEventListener("pointercancel", () => { backdropPressed = false })
dialog.addEventListener("click", event => {
  const dismiss = backdropPressed && onDialogBackdrop(event)
  backdropPressed = false
  if (dismiss) closeDialog()
})
dialog.addEventListener("close", () => { backdropPressed = false; dialogVersion++ })
document.getElementById("website").onclick = () => request("api/open-website", {}).catch((error) => toast(error.message))
void load()
setInterval(() => { if (!busy && !loading && !resourceLoading && !dialog.open) void load() }, 15000)
