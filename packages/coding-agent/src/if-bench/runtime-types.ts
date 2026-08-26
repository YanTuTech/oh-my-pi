import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { ApiKeyResolverModel } from "../config/api-key-resolver";
import type { Settings } from "../config/settings";

export type StreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface BenchModelRegistry {
	getAll(): Model<Api>[];
	getAvailable(): Model<Api>[];
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	hasConfiguredAuth?(model: Model<Api>): boolean;
}

export interface BenchRuntime {
	modelRegistry: BenchModelRegistry;
	settings?: Settings;
	close?: () => void;
}

export interface BenchTarget {
	selector: string;
	model: Model<Api>;
	thinking: ResolvedThinkingLevel | undefined;
}
