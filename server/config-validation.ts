/**
 * Startup validation for the parts of the config whose absence is otherwise
 * invisible until a user hits the feature.
 *
 * Lives outside config.ts because the Jest moduleNameMapper rewrites every
 * `./config` import to the stub, which would make these rules untestable.
 */

/** The subset of the config this module inspects. */
export interface ChatTierConfig {
  foundry?: {
    lowModel?: string;
    midModel?: string;
    highModel?: string;
  };
}

const CHAT_TIERS = [
  ['lowModel', 'FOUNDRY_LOW_MODEL'],
  ['midModel', 'FOUNDRY_MID_MODEL'],
  ['highModel', 'FOUNDRY_HIGH_MODEL'],
] as const;

/** Env var names for whichever chat tiers have no deployment name configured. */
export function missingChatTiers(cfg: ChatTierConfig): string[] {
  return CHAT_TIERS.filter(([key]) => !cfg.foundry?.[key]).map(([, envVar]) => envVar);
}

/**
 * Logs an unmissable startup error when a chat tier has no deployment name.
 *
 * An unset tier reaches Azure as `model: undefined` and comes back as a bare
 * 404, which every route reports to the author as "AI error occurred" — so a
 * missing app setting looks like a broken feature. This names it at boot.
 *
 * Deliberately not fatal: writing, reading and editing do not need a model, and
 * taking the whole site down over one app setting is the worse failure.
 */
export function warnIfChatTiersMissing(cfg: ChatTierConfig): void {
  const missing = missingChatTiers(cfg);
  if (missing.length === 0) return;

  console.error(
    '*** CONFIG ERROR: Foundry chat tiers are not configured — every AI feature ' +
      'will fail with "AI error occurred". Set ' +
      missing.join(', ') +
      ' (or the matching foundry.{lowModel,midModel,highModel} keys in ' +
      '_private/config.json) to an Azure OpenAI chat deployment name. ***',
  );
}
