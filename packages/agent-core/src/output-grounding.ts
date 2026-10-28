/** A narrow source check for years asserted in period headings or captions.
 * Monetary amounts, filesystem dates and the system date are not report years.
 */
export function unsupportedYear(content:string,goal:string,sources:string):string|null {
 const requested=goal.replace(/(?:https?:\/\/|\/|~\/)[^\s]+/g,'');
 const context=requested+'\n'+sources;
 const months='(?:Ocak|Şubat|Subat|Mart|Nisan|Mayıs|Mayis|Haziran|Temmuz|Ağustos|Agustos|Eylül|Eylul|Ekim|Kasım|Kasim|Aralık|Aralik|January|February|March|April|May|June|July|August|September|October|November|December)';
 const patterns=[new RegExp(`${months}\\s*(?:[-–]\\s*${months}\\s*)?\\s+((?:19|20)\\d{2})\\b`,'giu'),/\b((?:19|20)\d{2})\s+(?:yılı|yili|dönem(?:i|inde)?|donem(?:i|inde)?|financial year|period)(?=\s|[.,;:()\-]|$)/giu];
 for(const pattern of patterns)for(const match of content.matchAll(pattern)){const year=match[1]!;if(!new RegExp(`\\b${year}\\b`).test(context))return year;}
 return null;
}
