import type {Draft} from './types.js';
/** MIME may supply one final line ending. All other text and whitespace remain significant. */
export function draftProjection(draft:Draft){
 const addresses=(values:string[])=>values.map(value=>value.trim().toLowerCase()).sort();
 const body=draft.body.replace(/\r\n/g,'\n');
 return {to:addresses(draft.to),cc:addresses(draft.cc??[]),subject:draft.subject,body:body.endsWith('\n')?body:body+'\n'};
}
