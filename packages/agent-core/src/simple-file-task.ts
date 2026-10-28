/** A deliberately narrow literal write. Anything requiring interpretation,
 * source material, another action, or an existing-file edit stays general. */
export function simpleFileTask(goal: string): {path:string;content:string} | null {
  const match=/^(?:(?:SOHBETTEN GÖREVE TESTİ|HIZ TESTİ|TEST):\s*)?((?:\/|~\/)[^\s"“”]+\.(?:txt|md))\s+dosyasına\s+tam olarak\s+[“"]([^”"]{1,2000})[”"]\s+yaz\b([\s\S]*)$/iu.exec(goal.trim());
  if(!match)return null;
  const tail=match[3]!.toLocaleLowerCase("tr").replace(/(?:gerçek tek seferlik onay kartını kullan|sonra dosyayı geri okuyarak bu metnin aynen kaydedildiğini doğrula|tamamlanan adımları güncelle ve kısa sonuç ver|internet veya başka dosya kullanma|ve doğrula|sonra doğrula)/giu,"");
  if(/[^\s.!]/u.test(tail))return null;
  return {path:match[1]!,content:match[2]!};
}
