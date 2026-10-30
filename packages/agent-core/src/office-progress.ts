/** Explicit Craft export destinations, never prose or title-derived filenames. */
export function craftOutputPaths(name:string,args:Record<string,unknown>):string[] {
 if(!args||typeof args!=='object'||Array.isArray(args))return [];
 if(['document_edit','document_convert','slides_edit'].includes(name))return typeof args.out==='string'?[args.out]:[];
 if(['document_make','sheet_make','slides_make'].includes(name))return typeof args.path==='string'?[args.path]:[];
 if(/^(documents|sheets|slides)_engine_run$/.test(name)&&Array.isArray(args.outputs))return args.outputs.flatMap(o=>o&&typeof o==='object'&&typeof o.path==='string'?[o.path]:[]);
 return [];
}
export const officePath=(path:string)=>/\.(docx|xlsx|pptx)$/i.test(path);

/** Narrow local existing-file workflow. No bare names, new copies or native-window control. */
export function singleOfficeEditWorkflow(goal:string):{path:string;steps:string[]}|null {
 const quotedPaths=[...goal.matchAll(/["“`']((?:~\/|\/)[^"”`'\n]+)["”`']/gu)].map(m=>m[1]!);
 const unquoted=goal.replace(/["“`'][^"”`'\n]*["”`']/gu,'');
 const allPaths=[...new Set([...quotedPaths,...[...unquoted.matchAll(/(?<![\p{L}\p{N}_.])(?:~\/|\/)[^\s"'“”`]+/gu)].map(m=>m[0].replace(/[.,;:)]+$/u,''))])];
 if(allPaths.length!==1||!officePath(allPaths[0]!))return null;
 const path=allPaths[0]!,name=path.split('/').at(-1)!;
 const remaining=goal.split(path).join('').split(name).join('');
 if(/[\p{L}\p{N}_.-]+\.(?:docx|xlsx|pptx)\b/iu.test(remaining))return null;
 const instruction=unquoted.replace(/yeni\s+(?:bir\s+)?kopya\s+yerine/giu,'').replace(/yeni\s+(?:bir\s+)?(?:kopya|dosya)\s+(?:oluştur|olustur|yap|aç|ac|üret|uret)(?:ma|me|madan|meden)(?![\p{L}])/giu,'').replace(/(?:do not|don't|never|without)\s+(?:create|creating|make|making)\s+(?:a\s+)?new\s+(?:copy|file)|\bno\s+new\s+(?:copy|file)/giu,'');
 const intent=instruction.replace(/(?<![\p{L}\p{N}_.])(?:~\/|\/)[^\s"'“”`]+/gu,'');
 if(/e-?posta|email|\bsend\b|gönder|gonder|her\s+gün|her\s+gun|\bdaily\b|schedule|zamanla|takvim|yükle|yukle|publish|paylaş|paylas|özetle|ozetle|summari[sz]e/iu.test(intent))return null;
 if(/(?:sadece|yalnızca)\s+oku|read[ -]only|inspect only|yeni\s+(?:bir\s+)?(?:kopya|dosya)|new copy|save as|farklı\s+(?:bir\s+)?(?:ad|dosya)/iu.test(intent))return null;
 const native=intent.replace(/(?:Microsoft\s*Word|Excel|PowerPoint)[^.\n;]{0,55}(?:kullanma|açma|acma)/giu,'').replace(/(?:do not use|don't use|never use)[^.\n;]{0,55}(?:Microsoft\s*Word|Excel|PowerPoint)[^.\n;]*/giu,'');
 if(/(?:Microsoft\s*Word|Excel|PowerPoint)[^.\n;]{0,55}(?:uygulama|pencere|application|window)/iu.test(native))return null;
 const positive=intent.replace(/(?:değiştirme|degistirme|güncelleme|guncelleme|düzenleme|duzenleme)\s+yap/giu,'düzenle').replace(/(?<![\p{L}])(?:değiştirme|degistirme|güncelleme|guncelleme|düzenleme|duzenleme)(?![\p{L}])/giu,'').replace(/(?:do not|don't|never)\s+(?:edit|change|update|replace)[^;.!?\n]*/giu,'');
 if(!/değiştir|degistir|değişiklik\s+(?:istiyorum|yap)|degisiklik\s+(?:istiyorum|yap)|düzenle|duzenle|güncelle|guncelle|\bedit\b|\breplace\b|\bupdate\b|\bchange\b/iu.test(positive)||!/mevcut|existing|aynı\s+dosya|same\s+file|dosyasındaki|belgesindeki|replaceExisting/iu.test(intent))return null;
 return {path,steps:[`${name}: mevcut içeriği oku.`,`${name}: istenen değişikliği yedekle uygula ve doğrula.`]};
}
