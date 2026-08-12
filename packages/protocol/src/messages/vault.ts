import { z } from "zod";

/**
 * Vault machine-retrieval (plan §9). An allow-listed, authenticated device asks
 * the hub for a workflow secret by name; the hub enforces scoping + class and
 * returns the value, or an `error` with a secret_* / vault_locked /
 * biometric_required code. Personal secrets never come back over this path.
 */
export const VaultGet = z.object({
  type: z.literal("vault.get"),
  name: z.string(),
});
export type VaultGet = z.infer<typeof VaultGet>;

export const VaultSecret = z.object({
  type: z.literal("vault.secret"),
  name: z.string(),
  value: z.string(),
});
export type VaultSecret = z.infer<typeof VaultSecret>;

export const VaultMessage = z.discriminatedUnion("type", [VaultGet, VaultSecret]);
export type VaultMessage = z.infer<typeof VaultMessage>;
