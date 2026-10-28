/** Trusted file/document move coordination; never populated by model arguments. */
export interface SemanticMoveGuard {
 assertAvailable(paths:readonly string[]):void;
 begin(owner:string,paths:readonly string[]):string;
 settle(id:string,outcome:'verified'|'refused'|'unknown'):void;
}
