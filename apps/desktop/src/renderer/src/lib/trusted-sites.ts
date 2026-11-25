import type { MessageKey } from "@vunemi/i18n";
import type { TrustedSiteResult } from "../../../shared/ipc.js";

/** Why a site couldn't be added to the trusted list, in the user's words. */
export const TRUST_ERRORS: Record<Extract<TrustedSiteResult, { ok: false }>["reason"], MessageKey> = {
  invalid: "settings.trusted.error.invalid",
  "this-computer": "settings.trusted.error.thisComputer",
  full: "settings.trusted.error.full",
};
