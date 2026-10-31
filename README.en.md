# NovaFlow for Magpie

Connect stock Magpie to NovaFlow, use the AI models authorized for your account, and install, update and share company skills.

- **Account sync** with a dedicated plugin connection key.
- **Company skill store** with categories, search, publishers, versions and file previews.
- **Skill sharing** from your registered Magpie Library.
- **Configuration initialization** for Magpie Image, image generation and the stable update channel.
- **Light and dark themes** following Magpie.

Requires Magpie **0.1.2058 or newer** and a [NovaFlow account](https://www.ycnovaflow.vip). The server address is fixed; no server setup is needed.

## Install

Add the GitHub repository in Magpie's plugin page, or run:

```sh
magpie plugin add github:335234131/novaflow-magpie-plugins
```

Alternatively, download a production archive from [Releases](https://github.com/335234131/novaflow-magpie-plugins/releases), extract it, and select the extracted directory in Magpie. Do not add the `.tgz` file directly as a plugin directory.

Installation adds a **NovaFlow** provider and sidebar entry. Avoid enabling multiple NovaFlow copies together.

## Sign in

1. Sign in to [NovaFlow](https://www.ycnovaflow.vip) and open your profile.
2. Generate or copy the current **Magpie plugin connection key**.
3. In Magpie, open **Providers → Add provider → NovaFlow** and paste the key.
4. After sync, choose models, routes and Agents through Magpie's existing controls.

A connection key starts with `nfpc_`. It is not a model API key or account password. Each account has one current connection key; after rotation, sign in again with the replacement.

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

The NovaFlow provider must be enabled and signed in, with `gpt-image-2` available. Sign-in, background sync and **Sync now** do not initialize settings. Repeating initialization reapplies these settings; MCP changes may cause Agents to reload configuration.

## Connection and data

The fixed server is `https://www.ycnovaflow.vip`. The plugin automatically manages a local page service at `127.0.0.1:3488`; this is not the NovaFlow server.

Magpie stores sign-in credentials, and private plugin state stays under Magpie's configuration directory. Connection keys and model API keys are excluded from plugin pages, URLs and logs. NovaFlow provides model requests, company catalogs and shared skills; current platform permissions govern access.

## Troubleshooting

**No models?** Check that the NovaFlow provider is enabled and the connection key is valid, then sync. Enterprise administrators must configure model groups and access.

**Missing local skill?** Import it into Magpie Library first, then refresh the share list. An unregistered folder on disk is not listed.

**Installation failed?** Follow the reported error and retry. Download completion alone does not confirm Library registration.

**Sync stopped after rotation?** Sign in again using the new connection key from your NovaFlow profile.

## Support and license

- [NovaFlow](https://www.ycnovaflow.vip)
- [Issues](https://github.com/335234131/novaflow-magpie-plugins/issues)
- [中文](README.md)

This is a third-party community plugin, not an official Magpie endorsement. It derives from `sub2api-magpie-plugin` under the MIT License. Attribution and bundled Magpie style licenses are retained in [LICENSE](LICENSE), [NOTICE](NOTICE) and [docs/MAGPIE-LICENSE](docs/MAGPIE-LICENSE).
