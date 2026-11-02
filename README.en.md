# NovaFlow for Magpie

Connect stock Magpie to NovaFlow, use the AI models authorized for your account, and install, update and share company skills.

- **Account sync** with a dedicated plugin connection key; each authorized API key becomes a native Magpie provider named after its source group.
- **Provider icons**: newly added groups receive the NovaFlow logo automatically. Later account sync preserves your custom icon choices.
- **Native models and requests**: Magpie handles model discovery, reasoning effort, image detection and inference. The plugin does not rewrite model IDs or parse or forward inference requests.
- **Company skill store** with categories, search, publishers, versions and file previews.
- **Skill sharing** from your registered Magpie Library.
- **Configuration initialization** can be repeated; details start collapsed while the action stays visible.
- **Light and dark themes** following Magpie.

Requires Magpie **0.1.2058 or newer** and a [NovaFlow account](https://www.ycnovaflow.vip). The plugin uses the `www` server as canonical and also accepts the official `https://ycnovaflow.vip` domain; no server setup is needed.

## Install

Add the GitHub repository in Magpie's plugin page, or run:

```sh
magpie plugin add github:Azheyc/novaflow-magpie-plugins
```

Alternatively, download a production archive from [Releases](https://github.com/Azheyc/novaflow-magpie-plugins/releases), extract it, and select the extracted directory in Magpie. Do not add the `.tgz` file directly as a plugin directory.

Installation adds a **NovaFlow** sidebar entry; signing in creates native group providers for authorized keys. Avoid enabling multiple NovaFlow copies together.

## Sign in

1. Sign in to [NovaFlow](https://www.ycnovaflow.vip) and open your profile.
2. Generate or copy the current **Magpie plugin connection key**.
3. In Magpie, open **Plugins → NovaFlow** in the sidebar, paste the key, and click **Connect NovaFlow**.
4. The plugin creates **NovaFlow · group name** native providers and asks Magpie to fetch their models. Choose models, routes and Agents through Magpie's existing controls.

A connection key starts with `nfpc_`. It is not a model API key or account password. Each account has one current connection key; after rotation, sign in again with the replacement.

## Model connections

Manage sign-in, synchronization and sign-out in the plugin sidebar page. Models belong to the generated **NovaFlow · group name** native providers. Multiple keys in a group also show their key names.

The plugin synchronizes addresses, keys and protocol endpoints only. Magpie owns original model names and inference. Unchanged background polls do not rewrite configuration or refetch models; **Sync now** asks Magpie to fetch again. Model selections, disabled providers and other native settings are preserved. Manually replacing a managed connection's address or key reports a conflict instead of overwriting it.

Upgrading from 1.6.0 preserves existing group providers, model choices and the saved session while retiring the empty account provider. Manage sign-in through the sidebar page thereafter.

When upgrading from 1.5.x, select a model from a native provider in each Agent; old `nf:` references are no longer forwarded. Run **Initialize configuration** again to select an image model. Signing out clears the local session and connections still owned by the plugin, while keeping manually added providers and installed skills. It does not revoke the platform connection key or sign out other devices. Disabling or uninstalling the plugin does not sign out; sign out before uninstalling.

## Menu bar balance

In Magpie settings, select an enabled **NovaFlow · group name** under **Allowances in the menu bar**. Personal accounts show their available personal balance; enterprise accounts show the company's shared available balance in CNY. Group providers read the same account balance.

An existing selection of the old NovaFlow account entry moves to an enabled group during sync. The plugin does not enable menu bar allowances if you have not selected them. Magpie controls the refresh interval and manual refresh; custom balance queries are preserved.

## Company skills

Enterprise members can browse their company's skill store, filter by category or installation state, search, and preview files before installing or updating.

- Installation and updates are manual; the entire catalog is never installed automatically.
- Success requires an actual Magpie Library registration. Associate installed skills with Agents in Magpie Library.
- New installations use the original skill identifier. Existing same-name local skills are not overwritten.
- Withdrawal or deletion keeps installed copies, but disables remote downloads and updates.

### Share a skill

Only skills **already added to Magpie Library** can be shared.

1. Open **Library → Skills** and import an existing Agent skill, or find and add a local skill folder.
2. The folder root must contain an exact `SKILL.md`. Extract ZIP packages before importing.
3. Open **Share skill** in the NovaFlow plugin and refresh the list.
4. Select a skill, preview its files, confirm its name and description, choose a company category, and submit.

The description is prefilled from the local Library and remains editable. No skill identifier is required. A successful share is immediately available for coworkers to install. Sharing uploads the confirmed files to NovaFlow; keep credentials and private documents out of skill packages.

Company administrators manage categories, uploads, availability, deletion and versions on NovaFlow's **Skills and sync** page. Personal accounts retain account sync and initialization; company skill controls are disabled with guidance for opening an enterprise account.

## Initialize configuration

Initialization runs only after you click and confirm it. You can repeat it to:

- Install built-in `magpie-image` MCP and associate Agents already managed by Magpie.
- Select the authorized NovaFlow `gpt-image-2` image model.
- Set the Magpie update channel to stable.

Sign in to NovaFlow and let Magpie discover `gpt-image-2` as an image model on an enabled native provider. Sign-in, background sync and **Sync now** do not initialize settings. Repeating initialization reapplies these settings; MCP changes may cause Agents to reload configuration.

## Connection and data

The fixed server is `https://www.ycnovaflow.vip`. The plugin automatically manages a local page service at `127.0.0.1:3488`; this is not the NovaFlow server.

Connection keys and model API keys stay in protected local files under Magpie's configuration directory. The connection key authorizes account sync and balance queries; model API keys authorize inference. Saved credentials are never returned to the page, placed in URLs or written to logs. NovaFlow provides model requests, company catalogs and shared skills; current platform permissions govern access.

## Troubleshooting

**No models?** Check the connection status in the plugin page, then check the generated **NovaFlow · group name** providers, enable them and sync with a valid connection key. Enterprise administrators must configure model groups and access.

**Missing local skill?** Import it into Magpie Library first, then refresh the share list. An unregistered folder on disk is not listed.

**Installation failed?** Follow the reported error and retry. Download completion alone does not confirm Library registration.

**Sync stopped after rotation?** Sign in again using the new connection key from your NovaFlow profile.

## Support and license

- [NovaFlow](https://www.ycnovaflow.vip)
- [Issues](https://github.com/Azheyc/novaflow-magpie-plugins/issues)
- [中文](README.md)

This is a third-party community plugin, not an official Magpie endorsement. It derives from `sub2api-magpie-plugin` under the MIT License. Attribution and bundled Magpie style licenses are retained in [LICENSE](LICENSE), [NOTICE](NOTICE) and [docs/MAGPIE-LICENSE](docs/MAGPIE-LICENSE).
