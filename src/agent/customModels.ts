import * as fs from "node:fs";
import * as path from "node:path";

export interface UiModel {
    id: string;
    handle: string;
    label: string;
    description: string;
    isDefault?: boolean;
    isFeatured?: boolean;
    updateArgs?: Record<string, unknown>;
}

interface ProxyConfig {
    provider?: {
        [key: string]: {
            models: {
                [modelKey: string]: {
                    name?: string;
                    limit?: {
                        context?: number;
                        output?: number;
                    };
                    options?: {
                        thinking?: {
                            type?: string;
                            budgetTokens?: number;
                        };
                    };
                    reasoning?: boolean;
                };
            };
        };
    };
}

function loadProxyConfig(): ProxyConfig | null {
    try {
        const projectRoot = process.env.LETTA_PROJECT_ROOT || "/var/www/letta-code";
        const configPath = path.resolve(projectRoot, "proxy_config.json");
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            return JSON.parse(content);
        }
    } catch (e) {
        // console.warn("Failed to load proxy_config.json", e);
    }
    return null;
}

export function getDynamicModels(
    availableHandles: Set<string>,
    knownHandles: Set<string>
): UiModel[] {
    const dynamicModels: UiModel[] = [];
    const config = loadProxyConfig();

    // Flatten models helper and store sort order
    const configModels = new Map<string, any>();
    if (config?.provider) {
        for (const providerKey in config.provider) {
            const provider = config.provider[providerKey];
            if (provider.models) {
                let sortIndex = 0;
                for (const modelKey in provider.models) {
                    configModels.set(modelKey, provider.models[modelKey]);
                    configModels.set("_sort_order_" + modelKey, sortIndex++);
                }
            }
        }
    }

    availableHandles.forEach((handle) => {
        if (!knownHandles.has(handle)) {
            const parts = handle.split("/");
            const modelKey = parts.length > 1 ? parts[1] : handle;
            const providerPrefix = parts[0];

            const conf = configModels.get(modelKey);

            let label = modelKey;
            let description = providerPrefix === "openai-proxy" ? "Model via ProxyPal" : `Dynamic model from ${providerPrefix}`;
            const updateArgs: Record<string, unknown> = {};
            let isConfigured = false;

            if (conf) {
                if (conf.name) label = conf.name;
                if (conf.limit?.context) updateArgs.context_window = conf.limit.context;
                if (conf.limit?.output) updateArgs.max_output_tokens = conf.limit.output;

                if (conf.reasoning) {
                    updateArgs.enable_reasoner = true;
                }
                if (conf.options?.thinking?.budgetTokens) {
                    updateArgs.max_reasoning_tokens = conf.options.thinking.budgetTokens;
                }

                description += " (Configured)";
                isConfigured = true;
            }

            const sortOrder = configModels.get("_sort_order_" + modelKey);

            dynamicModels.push({
                id: handle,
                handle: handle,
                label: label,
                description: description,
                updateArgs: updateArgs,
                // @ts-ignore
                _sortIndex: isConfigured && sortOrder !== undefined ? sortOrder : 9999 + dynamicModels.length
            });
        }
    });

    // Sort: Configured models first (in order), then others
    dynamicModels.sort((a, b) => {
        // @ts-ignore
        return (a._sortIndex - b._sortIndex);
    });

    // Cleanup
    dynamicModels.forEach(m => {
        // @ts-ignore
        delete m._sortIndex;
    });

    return dynamicModels;
}
