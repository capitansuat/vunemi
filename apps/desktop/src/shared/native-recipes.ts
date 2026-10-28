/** Safe renderer projections only. Native identities/handles and authority tickets stay in main. */
export type NativeRecipeId='textedit.append-save.v1';
export type SetupOwner={setupSessionId:string;setupCallId:string};
export interface NativeRecipeTargetView {path:string;pid:number;windowId:number;title:string}
export type LocalSlot={local:string;offsetMinutes?:number};
export interface NativeRecipeSetupInput {recipeId:NativeRecipeId;target:{path:string;pid:number;windowId:number};literal:string;timeZone:string;slots:LocalSlot[]}
export interface NativeRecipeReadOffer extends SetupOwner {readOfferId:string;revision:number;expiresAt:number;target:NativeRecipeTargetView;recipeId:NativeRecipeId}
export interface NativeRecipeOffsetChoice {kind:'needs-offset';choices:{index:number;offsetMinutes:number[]}[]}
export type NativeAuthorityStatus='active'|'revoked'|'expired'|'reapproval-required'|'blocked-unknown'|'exhausted';
export type NativeSlotStatus='scheduled'|'reserved'|'skipped'|'backup-only'|'verified'|'unknown';
export interface NativeRecipeOffer extends SetupOwner {offerId:string;revision:number;expiresAt:number;recipeId:NativeRecipeId;target:NativeRecipeTargetView;literal:string;timeZone:string;slots:{slotId:string;at:number;backupPath:string}[];authorityExpiresAt:number}
export interface NativeRecipeView {automationId:string;revision:number;recipeId:NativeRecipeId;title:string;target:NativeRecipeTargetView;literal:string;timeZone:string;authorityStatus:NativeAuthorityStatus;remainingSlots:number;expiresAt:number;slots:{slotId:string;at:number;status:NativeSlotStatus;runId?:string;backupCreated?:boolean;reason?:string;backupPath:string;dispatchIds:string[]}[]}
export interface NativeRecipesSnapshot {streamId:string;revision:number;recipes:NativeRecipeView[]}
export type PrepareNativeRecipeRequest=SetupOwner & {readOfferId:string;readOfferRevision:number;decision:'allow-preparation-read'};
export type ApproveNativeRecipeRequest=SetupOwner & {offerId:string;offerRevision:number};
export type RevokeNativeRecipeRequest={automationId:string;expectedRevision:number};
