export interface NativeRecipeEpoch {
    app: string;
    uid: number;
    securitySessionId: number;
    policy: number;
    roots: number;
    connector: number;
    helperRevision: string;
    timeZone: string;
}
export type { NativeRecipeBinding, NativeRecipeSlotResult } from '@vunemi/mac';
declare const claimBrand: unique symbol;
export interface NativeRecipeClaim {
    readonly [claimBrand]: true;
}
