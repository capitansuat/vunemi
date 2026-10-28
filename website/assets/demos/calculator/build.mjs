import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {languages} from '../../../src/pages.mjs';
import {calculatorDemoCopy,demoKeys} from '../../../src/calculator-demo-copy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const out=path.join(root,'public/demos/calculator');
await fs.mkdir(out,{recursive:true});
for(const lang of languages)for(const key of demoKeys)if(!calculatorDemoCopy[lang]?.[key]?.trim())throw Error('Missing '+lang+'.'+key);
const copy=await fs.readFile(path.join(root,'src/calculator-demo-copy.mjs'),'utf8');
const renderer=await fs.readFile(path.join(here,'render.mjs'),'utf8');
const code=copy.replaceAll('export const ','const ')+renderer.replace(/^import[^\n]*\n/,'').replaceAll('export const ','const ').replaceAll('export function ','function ');
const logo='data:image/svg+xml;base64,'+(await fs.readFile(path.join(root,'public/icon.svg'))).toString('base64');
const options=languages.map(lang=>'<option value="'+lang+'">'+({en:'English',tr:'Türkçe',de:'Deutsch',es:'Español',fr:'Français',it:'Italiano',pt:'Português',ru:'Русский',zh:'中文',ja:'日本語',ko:'한국어'}[lang])+'</option>').join('');
const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vunemi · Calculator demo</title><style>html{color-scheme:light;background:#fbfaf8;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif}body{margin:0}main{max-width:1280px;margin:auto}#scene{aspect-ratio:16/9}#scene svg{display:block;width:100%;height:auto}.controls{display:flex;gap:10px;align-items:center;padding:12px 6%;color:#6e6b66}button,select{font:inherit;font-size:14px;border:1px solid #e6e2dc;border-radius:10px;background:#fff;padding:9px 14px;color:#1d1d1f}button{cursor:pointer}button:focus-visible,select:focus-visible{outline:3px solid #ff7a45;outline-offset:3px}input{min-width:20px;flex:1;accent-color:#ff7a45}label{font-size:14px}@media(max-width:600px){.controls{flex-wrap:wrap;padding:10px}label{display:none}input{flex-basis:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}</style></head><body><main><div id="scene"></div><noscript><img src="calculator-en-poster.png" alt="45383 × 564 ÷ 235 = 108919.2" width="1280" height="720"></noscript><div class="controls"><button id="play" type="button"></button><button id="replay" type="button"></button><input id="time" type="range" min="0" max="12" step="0.01" aria-label="Animation position"><label for="lang" id="language"></label><select id="lang">'+options+'</select></div></main><script>'+code+'\n'+
 'const logo='+JSON.stringify(logo)+';const allowed='+JSON.stringify(languages)+';let lang=new URLSearchParams(location.search).get("lang")||"en";if(!allowed.includes(lang))lang="en";let playing=!matchMedia("(prefers-reduced-motion: reduce)").matches;let current=playing?0:10.8;let last=performance.now();const scene=document.getElementById("scene"),play=document.getElementById("play"),replay=document.getElementById("replay"),slider=document.getElementById("time"),picker=document.getElementById("lang"),language=document.getElementById("language");function paint(t){current=t;scene.innerHTML=renderFrame(t,lang,logo);slider.value=t;const c=calculatorDemoCopy[lang];document.documentElement.lang=lang;document.title="Vunemi · "+c.title;play.textContent=playing?c.pause:c.play;play.setAttribute("aria-pressed",String(playing));replay.textContent=c.replay;language.textContent=c.language;picker.value=lang;slider.setAttribute("aria-label",c.replay)}window.setDemoTime=t=>{playing=false;paint(t)};window.setDemoLanguage=value=>{if(!allowed.includes(value))throw Error("Invalid locale");lang=value;paint(current)};play.onclick=()=>{playing=!playing;last=performance.now();paint(current)};replay.onclick=()=>{current=0;playing=true;last=performance.now();paint(current)};slider.oninput=()=>{playing=false;paint(Number(slider.value))};picker.onchange=()=>window.setDemoLanguage(picker.value);function tick(now){if(playing&&document.visibilityState==="visible")paint((current+(now-last)/1000)%duration);last=now;requestAnimationFrame(tick)}paint(current);requestAnimationFrame(tick);</script></body></html>';
await fs.writeFile(path.join(out,'index.html'),html);
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({kind:'illustrated-demo',duration:12,languages,verifiedWorkflow:'45383 × 564 ÷ 235 = 108919.2',capture:'Reconstructed animation; timing is illustrative',evidence:'research/desktop-input-2026-10-14/calculator-session.json'},null,2));
console.log('Preview built: '+out);
const postersOnly=process.argv.includes('--posters');
if(!process.argv.includes('--video')&&!postersOnly)process.exit(0);
const modulePath=process.env.VUNEMI_PLAYWRIGHT_MODULE;
if(!modulePath)throw Error('Set VUNEMI_PLAYWRIGHT_MODULE to the installed Playwright entrypoint.');
const {chromium}=await import(modulePath);
const browser=await chromium.launch({headless:true,executablePath:process.env.VUNEMI_CHROME_PATH});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'vunemi-calculator-demo-'));
const run=(args)=>new Promise((resolve,reject)=>{const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(errors.slice(-3000))));});
try {
 const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:1});
 await page.route('http://**',r=>r.abort());await page.route('https://**',r=>r.abort());
 await page.setContent(html,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
 const order=['tr','en',...languages.filter(l=>!['tr','en'].includes(l))];const exported=[];
 for(const lang of order){
  await page.evaluate(l=>window.setDemoLanguage(l),lang);await page.evaluate(()=>window.setDemoTime(10.8));
  const poster=path.join(out,'calculator-'+lang+'-poster.png');await page.locator('#scene').screenshot({path:poster});
  for(const time of [2.1,10.8]){
   await page.evaluate(t=>window.setDemoTime(t),time);
   const overflow=await page.evaluate(()=>[...document.querySelectorAll('#scene text')].flatMap(n=>{const b=n.getBBox(),x=Number(n.getAttribute('x')),y=Number(n.getAttribute('y'));const left=x<800&&y>130&&y<660;return b.x<0||b.x+b.width>1280||(left&&(b.x<90||b.x+b.width>749))?[n.textContent]:[];}));
   if(overflow.length)throw Error('Text overflows in '+lang+' at '+time+': '+JSON.stringify(overflow));
  }
  if(postersOnly){exported.push({lang,layout:'passed'});console.log('Poster/layout checked: '+lang);continue;}
  const frames=path.join(temp,lang);await fs.mkdir(frames);
  for(let i=0;i<360;i++){await page.evaluate(t=>window.setDemoTime(t),i/30);await page.locator('#scene').screenshot({path:path.join(frames,String(i).padStart(5,'0')+'.png')});}
  const input=['-y','-loglevel','error','-framerate','30','-i',path.join(frames,'%05d.png'),'-an','-t','12'];
  const mp4=path.join(out,'calculator-'+lang+'.mp4'),webm=path.join(out,'calculator-'+lang+'.webm');
  const encodes=await Promise.allSettled([run([...input,'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',mp4]),run([...input,'-c:v','libvpx-vp9','-crf','32','-b:v','0','-row-mt','1','-cpu-used','4','-pix_fmt','yuv420p',webm])]);
  for(const result of encodes)if(result.status==='rejected')throw result.reason;
  const files=await Promise.all([mp4,webm,poster].map(async f=>({file:path.basename(f),bytes:(await fs.stat(f)).size})));
  exported.push({lang,files});console.log(JSON.stringify({completed:lang,count:exported.length,total:languages.length,files}));
  await fs.rm(frames,{recursive:true});
 }
 await fs.writeFile(path.join(out,postersOnly?'layout-validation.json':'exports.json'),JSON.stringify(exported,null,2));
}finally{await browser.close();await fs.rm(temp,{recursive:true,force:true});}
