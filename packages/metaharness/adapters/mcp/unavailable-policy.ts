/**
 * Preserve OMP's existing missing-policy behavior: capability/fs and skills
 * catch this failed import and deny ambient reads. This is not an allow policy.
 * Production Leapsea policy modules are intentionally outside this MCP fixture.
 */
throw new Error("Managed product policy modules are unavailable in the isolated MCP benchmark");

export {};
