const OPERATIONS = new Set([
  "initialize",
  "status",
  "sync",
  "skill-store",
  "skill-detail",
  "install-store-skill",
  "enterprise-guide",
  "local-skills",
  "agents",
  "preview-skill",
  "share-skill",
  "remove-skill",
  "logout",
])

function capability(session, name, message) {
  authenticated(session, "请先连接 NovaFlow")
  if (session.projection().accountMode === "enterprise" && session.projection().capabilities?.[name] === true) return
  throw Object.assign(new Error(message), { code: "PLUGIN_CAPABILITY_DENIED", status: 403 })
}

function authenticated(session, message) {
  if (session.projection().status === "authenticated") return
  throw Object.assign(new Error(message), { code: "PLUGIN_SESSION_REVOKED", status: 401 })
}

export function createNativeControl({
  config,
  session,
  sync,
  accounts,
  nativeProviders,
  skills,
  host,
  api,
  preferencesStore,
  defaults,
  forgetHostAuth,
  hostVersion = config.hostMinVersion,
}) {
  function state() {
    const identity = session.projection()
    const skillState = skills.projection()
    if (identity.accountMode !== "enterprise" || !identity.capabilities?.company_skills) {
      skillState.catalog = []
      skillState.store = null
      skillState.entries = []
      skillState.count = 0
    }
    return {
      schema_version: 1,
      service: {
        origin: config.origin,
        pluginVersion: config.pluginVersion,
        hostVersion,
        hostMinVersion: config.hostMinVersion,
        compatible: true,
      },
      session: session.projection(),
      sync: { ...sync.projection(), skills: skillState },
      accounts: accounts.projection(),
      skills: skillState,
      defaults: defaults.status(),
      preferences: {},
      hostLibrary: {
        available: host.available === true,
        version: host.version ?? "",
        error: host.lastError ?? "",
      },
    }
  }

  async function command({ operation, payload = {}, auth = null } = {}) {
    if (!OPERATIONS.has(operation)) {
      throw Object.assign(new Error("Unknown NovaFlow native command"), {
        code: "PLUGIN_COMMAND_UNKNOWN",
        status: 400,
      })
    }
    if (auth) await session.activateAuth(auth)
    switch (operation) {
      case "status":
        return state()
      case "initialize":
        authenticated(session, "请先连接 NovaFlow 再初始化")
        await defaults.run()
        return state()
      case "sync":
        await sync.syncNow("native")
        return state()
      case "skill-store":
        authenticated(session, "Sign in to NovaFlow before opening the skill store")
        capability(session, "company_skills", "The company store requires an active enterprise account")
        await skills.refreshStore()
        return state()
      case "skill-detail":
        authenticated(session, "Sign in to NovaFlow before opening a skill")
        capability(session, "company_skills", "The company store requires an active enterprise account")
        if (String(payload.sourceKind ?? "") !== "company") throw Object.assign(new Error("Platform skill recommendations have been retired"), { code: "PLUGIN_CAPABILITY_DENIED", status: 403 })
        return skills.storeDetail({
          sourceKind: String(payload.sourceKind ?? ""),
          skillId: String(payload.skillId ?? ""),
        })
      case "install-store-skill": {
        authenticated(session, "Sign in to NovaFlow before installing a skill")
        const sourceKind = String(payload.sourceKind ?? "")
        capability(session, "company_skills", "Company skills require an active enterprise account")
        if (sourceKind !== "company") throw Object.assign(new Error("Platform skill recommendations have been retired"), { code: "PLUGIN_CAPABILITY_DENIED", status: 403 })
        const installed = await skills.installFromStore({
          sourceKind,
          skillId: String(payload.skillId ?? ""),
          targetAgents: [],
        })
        if (installed?.registration !== "registered") {
          throw Object.assign(new Error(installed?.registrationError?.message || "技能已下载，但尚未登记到 Magpie 资料库，请重试安装"), {
            code: "PLUGIN_SKILL_REGISTRATION_FAILED", status: 409,
          })
        }
        return state()
      }
      case "enterprise-guide":
        authenticated(session, "请先连接 NovaFlow")
        await host.openEnterpriseGuide()
        return { opened: true }
      case "local-skills":
        capability(session, "company_skills", "企业用户才可使用本机技能功能")
        return { skills: await host.listSkills() }
      case "agents":
        capability(session, "company_skills", "企业用户才可使用技能功能")
        return { agents: await host.listAgents() }
      case "preview-skill":
        capability(session, "contribute_skills", "This account cannot contribute company skills")
        return skills.previewShare({
          sourceName: String(payload.sourceName ?? ""),
        })
      case "share-skill":
        capability(session, "contribute_skills", "This account cannot contribute company skills")
        return skills.share({
          sourceName: String(payload.sourceName ?? ""),
          display_name: String(payload.display_name ?? ""),
          description: payload.description === undefined ? undefined : String(payload.description),
          category_id: String(payload.category_id ?? ""),
          updateSkillId: payload.updateSkillId ? String(payload.updateSkillId) : "",
          expectedVersion: Number(payload.expectedVersion ?? 0),
          idempotencyKey: String(payload.idempotencyKey ?? ""),
        })
      case "remove-skill": {
        capability(session, "company_skills", "企业用户才可使用技能功能")
        const skillId = String(payload.skillId ?? "")
        const entry = skills.registry[skillId]
        if (!entry?.alias || !/^nf-[a-f0-9]{8}-[a-z0-9][a-z0-9_-]{0,60}$/.test(entry.alias)) {
          throw Object.assign(new Error("Managed company skill was not found"), {
            code: "PLUGIN_SKILL_NOT_FOUND",
            status: 404,
          })
        }
        const removed = await host.removeSkill(entry.alias)
        entry.registration = removed.registered ? "failed" : "removed"
        skills.persist()
        return state()
      }
      case "logout": {
        const result = await session.logout()
        await nativeProviders?.clear()
        if (forgetHostAuth) await forgetHostAuth()
        accounts.disposeOwnedOnly()
        sync.stop("NovaFlow signed out")
        return { result, state: state() }
      }
    }
  }

  return { command }
}

export { OPERATIONS }
