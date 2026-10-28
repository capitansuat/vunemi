import {csvIssue} from './csv.js';
export interface TextChecks { contains?: string[]; excludes?: string[]; rows?: number; lines?: number; nonempty?: boolean }
/** Executes explicit content assertions; supplied expectations are not independent facts. */
export function verifyText(text:string,checks:TextChecks,fileName?:string):string|null {
 if(!checks || typeof checks!=='object' || Array.isArray(checks))return 'Expected a checks object.';
 if(Object.keys(checks).some(key=>!['contains','excludes','rows','lines','nonempty'].includes(key)))return 'Unknown text check; use contains/excludes, rows for CSV only, or lines for text.';
 if(checks.nonempty!==undefined){if(checks.nonempty!==true)return 'Invalid nonempty check.';if(!text.trim())return 'Output is empty.';}
 const csv=fileName?.toLowerCase().endsWith('.csv');
 if(fileName && checks.rows!==undefined && !csv)return 'CSV rows checks apply only to .csv files. Use contains/excludes for Markdown/text or lines for logical text line count.';
 if(csv){const issue=csvIssue(text);if(issue)return issue;}
 if(fileName?.toLowerCase().endsWith('.json')){try{JSON.parse(text);}catch{return 'Invalid JSON structure.';}}
 if(checks.lines!==undefined){
  if(!Number.isInteger(checks.lines)||checks.lines<0)return 'Invalid line count.';
  const count=text.length ? text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n').length : 0;
  if(count!==checks.lines)return `Text has ${count} lines; expected ${checks.lines}.`;
 }
 if(checks.rows!==undefined){if(!Number.isInteger(checks.rows)||checks.rows<0)return 'Invalid row count.';const issue=csvIssue(text,checks.rows);if(issue)return issue;}
 for(const key of ['contains','excludes'] as const){const values=checks[key];if(values!==undefined&&(!Array.isArray(values)||values.length>50||values.some(s=>typeof s!=='string'||!s.length||s.length>1000)))return 'Invalid content checks.';}
 const visible=(s:string)=>s.replace(/\*\*|__|`/g,'');
 const includes=(value:string)=>text.includes(value)||visible(text).includes(visible(value));
 for(const value of checks.contains??[])if(!includes(value))return `Missing required content: ${value}`;
 for(const value of checks.excludes??[])if(includes(value))return `Forbidden content found: ${value}`;
 if(checks.rows===undefined&&checks.lines===undefined&&checks.nonempty!==true&&!checks.contains?.length&&!checks.excludes?.length)return 'Supply at least one source-grounded content check.';
 return null;
}
