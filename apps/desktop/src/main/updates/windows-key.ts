/**
 * The public half of the key Windows updates are signed with
 * (scripts/update-key.mjs makes the pair; the private half stays with the
 * maintainer). Null until it is made: then no Windows update is offered.
 */
export const WINDOWS_UPDATE_KEY: string | null = null;
