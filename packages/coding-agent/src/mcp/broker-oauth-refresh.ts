import type { OAuthCredential, OAuthProvider } from "@oh-my-pi/pi-ai";
import { refreshOAuthToken } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { refreshManagedMcpOAuthCredential } from "./oauth-credentials";
import { isManagedMCPOAuthCredentialId, mcpOAuthServerUrlFromCredentialId } from "./oauth-flow";

/** Refresh provider or MCP OAuth rows held by a headless auth-broker host. */
export function refreshBrokerOAuthCredential(
	provider: string,
	credential: OAuthCredential,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (isManagedMCPOAuthCredentialId(provider)) {
		return refreshManagedMcpOAuthCredential(credential, {
			serverUrl: mcpOAuthServerUrlFromCredentialId(provider),
			signal,
		});
	}
	return refreshOAuthToken(provider as OAuthProvider, credential);
}
