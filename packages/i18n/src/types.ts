import type { messages as source } from "./messages/tr.js";

/** Plural forms by Intl.PluralRules category. Only `other` is required; Turkish needs no more. */
export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

/** The Turkish catalogue's shape, with its texts widened to any string. */
type Shape<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends { other: string } ? PluralForms : Shape<T[K]>;
};

export type Catalogue = Shape<typeof source>;

type Paths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string | { other: string } ? `${Prefix}${K}` : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every key there is, checked where it is used. */
export type MessageKey = Paths<typeof source>;
