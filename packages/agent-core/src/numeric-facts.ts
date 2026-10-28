interface Stats { count:number;sum:number;mean:number;first:number;last:number;change:number;changePercent:number|null }
interface Difference { left:string;right:string;sum:number;ratioOfSumsPercent:number|null;meanRowRatioPercent:number|null;values?:{row:number;difference:number;ratioPercent:number|null}[] }
export interface NumericTableFacts { rows:number;numericFormat:'decimal_dot';columns:Record<string,Stats>;differences:Difference[] }
const cells=(line:string)=>line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s=>s.trim().replace(/^"|"$/g,'').replace(/""/g,'"'));
const number=(s:string)=>/^-?\d+(?:\.\d+)?$/.test(s)?Number(s):NaN;
/** Bounded statistics for ordinary decimal-point numeric CSV; no evaluation of source code. */
export function numericFacts(source:string):NumericTableFacts[] {
 const lines=source.split(/\r?\n/);const facts:NumericTableFacts[]=[];
 for(let i=0;i<lines.length&&facts.length<4;i++){
  const header=cells(lines[i]!);if(header.length<2||header.length>20||header.some(s=>!s||Number.isFinite(number(s))))continue;
  const rows:string[][]=[];
  while(i+1<lines.length&&rows.length<1000){const r=cells(lines[i+1]!);if(r.length!==header.length)break;rows.push(r);i++;}
  if(!rows.length)continue;
  const cols=header.flatMap((name,j)=>{const values=rows.map(r=>number(r[j]!));return values.every(Number.isFinite)?[{name,values}]:[];}).slice(0,8);
  if(!cols.length)continue;
  const columns:Record<string,Stats>={};
  for(const c of cols){const sum=c.values.reduce((a,b)=>a+b,0),first=c.values[0]!,last=c.values.at(-1)!;columns[c.name]={count:c.values.length,sum,mean:sum/c.values.length,first,last,change:last-first,changePercent:first?(last-first)/first*100:null};}
  const differences:Difference[]=[];
  for(let a=0;a<cols.length;a++)for(let b=a+1;b<cols.length;b++){
   const left=cols[a]!,right=cols[b]!,sum=columns[left.name]!.sum-columns[right.name]!.sum;
   const ratios=left.values.map((v,k)=>v?(v-right.values[k]!)/v*100:NaN);
   differences.push({left:left.name,right:right.name,sum,...(rows.length<=32 ? {values:left.values.map((v,k)=>({row:k+1,difference:v-right.values[k]!,ratioPercent:v?(v-right.values[k]!)/v*100:null}))} : {}),ratioOfSumsPercent:columns[left.name]!.sum?sum/columns[left.name]!.sum*100:null,meanRowRatioPercent:ratios.every(Number.isFinite)?ratios.reduce((a,b)=>a+b,0)/ratios.length:null});
  }
  facts.push({rows:rows.length,numericFormat:'decimal_dot',columns,differences});
 }
 return facts;
}
/** A narrow financial-label check; other prose is left to the source reviewer. */
export function wrongAverageMargin(output:string,source:string):string|null {
 const label='(?:ortalama\\s+k[âa]r\\s+marj[ıi]|average\\s+(?:profit\\s+)?margin)';
 const patterns=[new RegExp(`${label}[^\\d\\n]{0,40}(\\d+(?:[.,]\\d+)?)`,'giu'),new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*%?\\s+${label}`,'giu')];
 const pair=numericFacts(source).flatMap(t=>t.differences).find(p=>/gelir|revenue|income/i.test(p.left)&&/gider|cost|expense/i.test(p.right));
 if(pair?.meanRowRatioPercent==null)return null;
 const expected=Math.round(pair.meanRowRatioPercent*100)/100;
 for(const pattern of patterns)for(const match of output.matchAll(pattern)){
  const at=match.index!;if(/ağırlıklı|agirlikli|weighted/i.test(output.slice(Math.max(0,at-30),at+match[0].length+30)))continue;
  const value=Number(match[1]!.replace(',','.'));if(Math.abs(value-expected)>0.011)return `The arithmetic average monthly profit margin is ${expected.toFixed(2)}%, not ${value}%. The ratio of total profit to total revenue is ${pair.ratioOfSumsPercent?.toFixed(2)}% and must be labelled total/aggregate (or explicitly weighted), not an unqualified average.`;
 }
 return null;
}
