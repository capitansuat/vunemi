/**
 * The public half of the key Windows updates are signed with
 * (scripts/update-key.mjs makes the pair; the private half stays with the
 * maintainer). Null until it is made: then no Windows update is offered.
 */
export const WINDOWS_UPDATE_KEY: string | null = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAj15sXJPZ6LE0GfWYvmUyu4AuLgDO4uh+0SbnpF6QpsQ=
-----END PUBLIC KEY-----
`;
