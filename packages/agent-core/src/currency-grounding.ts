const CODES=/\b(TL|TRY|USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|JPY|CNY|CHF)\b/gi;
const SYMBOLS:Record<string,string[]>={'$':['USD','CAD','AUD','NZD','HKD','SGD'],'€':['EUR'],'£':['GBP'],'₺':['TRY'],'¥':['JPY','CNY']};
function withoutPaths(text:string):string {return text.replace(/["“](?:~\/|\/)[^"”]+["”]/g,'').replace(/(?:~\/|\/)[^\s"“”]+/g,'');}
/** $B$2 in a formula or a chart's cells is an absolute cell reference, not dollars. */
const withoutCellRefs=(text:string)=>text.replace(/\$?\b[A-Z]{1,3}\$\d+\b/g,'');
function codes(text:string):Set<string> {
 const normalized=text.replace(/_/g,' '),result=new Set<string>();
 const add=(value:string)=>{if(value.toUpperCase()==='TRY'&&value!=='TRY')return;result.add(value.toUpperCase()==='TL'?'TRY':value.toUpperCase());};
 for(const m of normalized.matchAll(CODES)) {
  if(m[1]!.toUpperCase()==='TRY'&&/^\s+(?:again|to)\b/iu.test(normalized.slice(m.index!+m[0].length)))continue;
  add(m[1]!);
 }
 for(const m of normalized.matchAll(/\d\s*(TL|TRY|USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|JPY|CNY|CHF)\b/gi))add(m[1]!);
 if(/türk lirası/iu.test(text))result.add('TRY');
 return result;
}
/** Conservative monetary labels: a filename or the Mac locale is not a unit.
 * Dollar/yen symbols remain ambiguous; never infer their country. */
export function unsupportedCurrency(output:string,goal:string,sources:string):string|null {
 const request=withoutPaths(goal),data=withoutPaths(sources),shown=withoutCellRefs(withoutPaths(output));
 if(!/(?:satış|satis|maliyet|kâr|\bkar\b|\bsales\b|\bcost\b|revenue|profit|currency|para birimi)/iu.test(request+' '+data))return null;
 const allowed=new Set([...codes(request),...codes(data)]);
 const forbidden=new Set([...request.matchAll(/(?:[“"]?)(TL|TRY|USD|EUR|GBP|CAD|AUD|JPY|CNY)(?:[”"]?)\s+(?:ekleme|kullanma|eklemeden|kullanmadan)/giu)].map(m=>m[1]!.toUpperCase()==='TL'?'TRY':m[1]!.toUpperCase()));
 for(const code of codes(shown))if(forbidden.has(code)||!allowed.has(code))return code;
 for(const [symbol,candidates] of Object.entries(SYMBOLS)) {
  const literal=symbol==='$'?'\\$':symbol;
  const priced=(text:string)=>new RegExp(literal+'\\s*\\d|\\d\\s*'+literal,'u').test(text);
  if(priced(shown)&&!priced(request+' '+data)&&!candidates.some(code=>allowed.has(code)&&!forbidden.has(code)))return symbol;
 }
 return null;
}
