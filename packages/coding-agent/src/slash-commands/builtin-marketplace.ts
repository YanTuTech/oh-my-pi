import { PluginManager } from "../extensibility/plugins";
import { createMarketplaceManager } from "./helpers/marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "./marketplace-install-parser";
import type { SlashCommandSpec } from "./runtime-types";
export const BUILTIN_MARKETPLACE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "marketplace",
		description: "Manage marketplace plugin sources and installed plugins",
		acpDescription: "Manage plugins from marketplaces",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "add", description: "Add a marketplace source", usage: "<source>" },
			{ name: "remove", description: "Remove a marketplace source", usage: "<name>" },
			{ name: "update", description: "Update marketplace catalog(s)", usage: "[name]" },
			{ name: "list", description: "List configured marketplaces" },
			{ name: "discover", description: "Browse available plugins", usage: "[marketplace]" },
			{
				name: "install",
				description: "Install a plugin (interactive browser if no args)",
				usage: "[--force] [name@marketplace]",
			},
			{ name: "uninstall", description: "Uninstall a plugin (selector if no args)", usage: "[name@marketplace]" },
			{ name: "installed", description: "List installed marketplace plugins" },
			{ name: "upgrade", description: "Upgrade outdated plugins", usage: "[name@marketplace]" },
			{ name: "help", description: "Show usage guide" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				try {
					const manager = await createMarketplaceManager(runtime);
					const marketplaces = await manager.listMarketplaces();
					if (marketplaces.length === 0) {
						await runtime.output(
							"No marketplaces configured.\n\nGet started:\n  /marketplace add anthropics/claude-plugins-official\n\nThen browse with /marketplace discover",
						);
					} else {
						const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
						await runtime.output(
							`Marketplaces:\n${lines.join("\n")}\n\nUse /marketplace discover to browse plugins, or /marketplace help for all commands`,
						);
					}
					return commandConsumed();
				} catch (err) {
					return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
				}
			}
			if (verb === "help") {
				await runtime.output(
					[
						"Marketplace commands:",
						"  /marketplace                              List configured marketplaces",
						"  /marketplace add <source>                  Add a marketplace (e.g. owner/repo)",
						"  /marketplace remove <name>                 Remove a marketplace",
						"  /marketplace update [name]                 Re-fetch catalog(s)",
						"  /marketplace list                          List configured marketplaces",
						"  /marketplace discover [marketplace]        Browse available plugins",
						"  /marketplace install <name@marketplace>    Install a plugin",
						"  /marketplace uninstall <name@marketplace>  Uninstall a plugin",
						"  /marketplace installed                     List installed plugins",
						"  /marketplace upgrade [name@marketplace]    Upgrade plugin(s)",
						"",
						"Quick start:",
						"  /marketplace add anthropics/claude-plugins-official",
					].join("\n"),
				);
				return commandConsumed();
			}
			try {
				const manager = await createMarketplaceManager(runtime);
				switch (verb) {
					case "add": {
						if (!rest) return usage("Usage: /marketplace add <source>", runtime);
						const entry = await manager.addMarketplace(rest);
						await runtime.output(`Added marketplace: ${entry.name}`);
						return commandConsumed();
					}
					case "remove":
					case "rm": {
						if (!rest) return usage("Usage: /marketplace remove <name>", runtime);
						await manager.removeMarketplace(rest);
						await runtime.output(`Removed marketplace: ${rest}`);
						return commandConsumed();
					}
					case "update": {
						if (rest) {
							await manager.updateMarketplace(rest);
							await runtime.output(`Updated marketplace: ${rest}`);
						} else {
							const results = await manager.updateAllMarketplaces();
							await runtime.output(`Updated ${results.length} marketplace(s)`);
						}
						return commandConsumed();
					}
					case "list": {
						const marketplaces = await manager.listMarketplaces();
						if (marketplaces.length === 0) {
							await runtime.output("No marketplaces configured.");
						} else {
							const lines = marketplaces.map(m => `  ${m.name}  ${m.sourceUri}`);
							await runtime.output(`Marketplaces:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "discover": {
						const plugins = await manager.listAvailablePlugins(rest || undefined);
						if (plugins.length === 0) {
							const marketplaces = await manager.listMarketplaces();
							await runtime.output(
								marketplaces.length === 0
									? "No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official"
									: "No plugins available in configured marketplaces",
							);
							return commandConsumed();
						}
						const lines = ["Available plugins:"];
						for (const plugin of plugins) {
							lines.push(`  - ${plugin.name}${plugin.version ? `@${plugin.version}` : ""}`);
							if (plugin.description) lines.push(`      ${plugin.description}`);
						}
						await runtime.output(lines.join("\n"));
						return commandConsumed();
					}
					case "install": {
						const parsed = parseMarketplaceInstallArgs(rest);
						if ("error" in parsed) return usage(parsed.error, runtime);
						const atIndex = parsed.installSpec.lastIndexOf("@");
						const pluginName = parsed.installSpec.slice(0, atIndex);
						const marketplace = parsed.installSpec.slice(atIndex + 1);
						await manager.installPlugin(pluginName, marketplace, { force: parsed.force, scope: parsed.scope });
						await runtime.reloadPlugins();
						await runtime.output(`Installed ${pluginName} from ${marketplace}`);
						return commandConsumed();
					}
					case "uninstall": {
						const parsed = parsePluginScopeArgs(
							rest,
							"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
						);
						if ("error" in parsed) return usage(parsed.error, runtime);
						await manager.uninstallPlugin(parsed.pluginId, parsed.scope);
						await runtime.reloadPlugins();
						await runtime.output(`Uninstalled ${parsed.pluginId}`);
						return commandConsumed();
					}
					case "installed": {
						const installed = await manager.listInstalledPlugins();
						if (installed.length === 0) {
							await runtime.output("No marketplace plugins installed");
						} else {
							const lines = installed.map(
								p => `  ${p.id} [${p.scope}]${p.shadowedBy ? " [shadowed]" : ""} (${p.entries.length} entry)`,
							);
							await runtime.output(`Installed plugins:\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					case "upgrade": {
						if (rest) {
							const parsed = parsePluginScopeArgs(
								rest,
								"Usage: /marketplace upgrade [--scope user|project] <name@marketplace>",
							);
							if ("error" in parsed) return usage(parsed.error, runtime);
							const result = await manager.upgradePlugin(parsed.pluginId, parsed.scope);
							await runtime.reloadPlugins();
							await runtime.output(`Upgraded ${parsed.pluginId} to ${result.version}`);
							return commandConsumed();
						}
						const results = await manager.upgradeAllPlugins();
						if (results.length === 0) {
							await runtime.output("All marketplace plugins are up to date");
						} else {
							await runtime.reloadPlugins();
							const lines = results.map(r => `  ${r.pluginId}: ${r.from} -> ${r.to}`);
							await runtime.output(`Upgraded ${results.length} plugin(s):\n${lines.join("\n")}`);
						}
						return commandConsumed();
					}
					default:
						return usage(
							`Unknown /marketplace subcommand: ${verb}. Use /marketplace help for available commands.`,
							runtime,
						);
				}
			} catch (err) {
				return usage(`Marketplace error: ${errorMessage(err)}`, runtime);
			}
		},
	},
	{
		name: "plugins",
		description: "View and manage installed plugins",
		acpDescription: "Manage plugins",
		acpInputHint: "[list|enable|disable]",
		subcommands: [
			{ name: "list", description: "List all installed plugins (npm + marketplace)" },
			{ name: "enable", description: "Enable a marketplace plugin", usage: "<name@marketplace>" },
			{ name: "disable", description: "Disable a marketplace plugin", usage: "<name@marketplace>" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			try {
				if (verb === "enable" || verb === "disable") {
					const parsed = parsePluginScopeArgs(
						rest,
						`Usage: /plugins ${verb} [--scope user|project] <name@marketplace>`,
					);
					if ("error" in parsed) return usage(parsed.error, runtime);
					const manager = await createMarketplaceManager(runtime);
					const isEnable = verb === "enable";
					await manager.setPluginEnabled(parsed.pluginId, isEnable, parsed.scope);
					await runtime.reloadPlugins();
					await runtime.output(`${isEnable ? "Enabled" : "Disabled"} ${parsed.pluginId}`);
					return commandConsumed();
				}
				// Default: list
				const lines: string[] = [];
				const npmManager = new PluginManager();
				const npmPlugins = await npmManager.list();
				if (npmPlugins.length > 0) {
					lines.push("npm plugins:");
					for (const plugin of npmPlugins) {
						const status = plugin.enabled === false ? " (disabled)" : "";
						lines.push(`  ${plugin.name}@${plugin.version}${status}`);
					}
				}

				const marketplaceManager = await createMarketplaceManager(runtime);
				const marketplacePlugins = await marketplaceManager.listInstalledPlugins();
				if (marketplacePlugins.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("marketplace plugins:");
					for (const plugin of marketplacePlugins) {
						const entry = plugin.entries[0];
						const status = entry?.enabled === false ? " (disabled)" : "";
						const shadowed = plugin.shadowedBy ? " [shadowed]" : "";
						lines.push(`  ${plugin.id} v${entry?.version ?? "?"}${status} [${plugin.scope}]${shadowed}`);
					}
				}

				await runtime.output(lines.length === 0 ? "No plugins installed" : lines.join("\n"));
				return commandConsumed();
			} catch (err) {
				return usage(`Plugin error: ${errorMessage(err)}`, runtime);
			}
		},
	},
	{
		name: "reload-plugins",
		description: "Reload all plugins (skills, commands, hooks, tools, agents, MCP)",
		acpDescription: "Reload all plugins",
		handle: async (_command, runtime) => {
			await runtime.reloadPlugins();
			await runtime.output("Plugins reloaded.");
			return commandConsumed();
		},
	},
];
