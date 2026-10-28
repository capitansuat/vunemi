import {calculatorDemoCopy} from '../../../src/calculator-demo-copy.mjs';
export const duration=12;
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const rect=(x,y,w,h,r,fill,stroke='none')=>'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+r+'" fill="'+fill+'" stroke="'+stroke+'"/>';
const circle=(x,y,r,fill)=>'<circle cx="'+x+'" cy="'+y+'" r="'+r+'" fill="'+fill+'"/>';
const text=(x,y,s,size=20,fill='#1d1d1f',weight=400,anchor='start',width)=>'<text x="'+x+'" y="'+y+'" font-size="'+size+'" fill="'+fill+'" font-weight="'+weight+'" text-anchor="'+anchor+'"'+(width?' textLength="'+width+'" lengthAdjust="spacingAndGlyphs"':'')+'>'+esc(s)+'</text>';
const fit=(s,width,size=20)=>Math.min(size,width/(Array.from(s).reduce((n,c)=>n+(/[\u3000-\uffff]/.test(c)?1:.57),0)));
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const frames=[
 [0,'0',null],[3.0,'4','4'],[3.18,'45','5'],[3.36,'453','3'],[3.54,'4,538','8'],[3.72,'45,383','3'],
 [4.15,'45,383 ×','×'],[4.5,'45,383 × 5','5'],[4.7,'45,383 × 56','6'],[4.9,'45,383 × 564','4'],
 [5.35,'25,596,012','='],[6.25,'25,596,012 ÷','÷'],[6.8,'25,596,012 ÷ 2','2'],[7.04,'25,596,012 ÷ 23','3'],[7.28,'25,596,012 ÷ 235','5'],
 [8.1,'108,919.2','='],[8.6,'108,919.2',null],
];
export function renderFrame(seconds,lang='en',logo='') {
 const t=Math.max(0,Math.min(duration,seconds));const c=calculatorDemoCopy[lang]??calculatorDemoCopy.en;
 const step=frames.findLast(f=>t>=f[0]);const verified=t>=8.6;const approval=t>=1.05&&t<2.85;
 const approveOpacity=smooth((t-1.05)/.3)*(1-smooth((t-2.6)/.25));const workingOpacity=smooth((t-2.9)/.35);
 const nativeNumber=new Intl.NumberFormat(lang,{maximumFractionDigits:1}).format(108919.2);
 let s='<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" role="img" aria-label="'+esc(c.title)+'"><defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#211a13" flood-opacity=".08"/></filter></defs><g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif">';
 s+=rect(0,0,1280,720,0,'#fbfaf8');
 if(logo)s+='<image href="'+logo+'" x="76" y="30" width="36" height="36"/>';
 s+=text(123,55,'Vunemi',23,'#1d1d1f',650)+text(78,114,c.title,fit(c.title,1120,39),'#1d1d1f',650);
 s+='<g filter="url(#shadow)">'+rect(78,158,688,482,24,'#faf6f0','#ece5da')+'</g>';
 s+=circle(104,182,5,'#ed776c')+circle(122,182,5,'#eac260')+circle(140,182,5,'#80bb8b');
 s+=rect(646,170,94,26,13,'#fff','#e6e2dc')+circle(660,183,3,'#3f8f5a')+text(675,187,c.local,fit(c.local,58,12),'#6e6b66',500);
 const userOpacity=smooth((t-.12)/.38);s+='<g opacity="'+userOpacity+'">'+rect(104,216,636,116,17,'#fff','#ece5da')+text(126,250,c.ask,fit(c.ask,590,20),'#6e6b66')+text(126,297,'45383 × 564 ÷ 235',33,'#1d1d1f',600)+'</g>';
 s+='<g opacity="'+approveOpacity+'">'+rect(104,360,636,178,17,'#fff','#e6e2dc')+text(127,397,c.permission,fit(c.permission,585,22),'#1d1d1f',600);
 s+=rect(126,421,318,43,11,'#1d1d1f')+text(285,449,c.always,fit(c.always,286,17),'#fff',500,'middle');
 s+=rect(460,421,257,43,11,'#f2f0ec')+text(588,449,c.once,fit(c.once,223,17),'#6e6b66',400,'middle')+text(694,507,c.reject,15,'#8a867f',400,'end');
 if(approval&&t>2.0){const k=smooth((t-2)/.45),x=360-68*k,y=536-91*k;s+='<g transform="translate('+x+','+y+')"><path d="M0 0 0 26 7 19 13 31 18 28 12 17 22 16Z" fill="#fff" stroke="#1d1d1f" stroke-width="2"/></g>';if(t>2.45)s+='<circle cx="286" cy="443" r="'+(16+20*smooth((t-2.45)/.3))+'" fill="none" stroke="#ff7a45" stroke-width="3" opacity="'+(1-smooth((t-2.45)/.3))+'"/>';}
 s+='</g>';
 s+='<g opacity="'+workingOpacity+'">'+rect(104,359,636,185,17,verified?'#f0f7f1':'#fff',verified?'#cde1d1':'#e6e2dc');
 s+=circle(133,392,6,verified?'#3f8f5a':'#ff7a45')+text(152,400,verified?c.result:c.working,fit(verified?c.result:c.working,540,22),'#1d1d1f',600);
 if(verified){s+=text(126,460,nativeNumber,46,'#287043',650)+text(126,507,c.verified,fit(c.verified,554,18),'#3f8f5a');s+='<path d="m663 447 11 11 22-26" fill="none" stroke="#3f8f5a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>';}
 else{s+=text(126,445,'45383 × 564 ÷ 235',28,'#1d1d1f',500);for(let i=0;i<3;i++)s+=circle(136+i*19,497,4,'#ff7a45');}
 s+='</g>';
 s+=text(110,599,verified?c.complete:c.local,fit(verified?c.complete:c.local,600,16),'#6e6b66',500);
 s+='<g filter="url(#shadow)">'+rect(835,157,367,483,25,'#202426')+'</g>'+circle(859,182,4,'#ed776c')+circle(874,182,4,'#eac260')+circle(889,182,4,'#80bb8b')+text(912,186,'Calculator',14,'#bcc0c2');
 s+=text(1176,245,step[1],fit(step[1],315,38),'#fff',400,'end');
 const keys=['⌫','C','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','±','0','.','='];
 keys.forEach((key,i)=>{const col=i%4,row=Math.floor(i/4),x=887+col*83,y=290+row*74;const glow=key===step[2]&&t-step[0]<.23;const fill=glow?'#ff7a45':col===3?'#52585b':row===0?'#484d50':'#383d40';s+=circle(x,y,32,fill)+text(x,y+9,key,key==='⌫'?26:30,'#fff',400,'middle');});
 s+=text(640,685,c.note,fit(c.note,1120,13),'#8a867f',400,'middle');
 return s+'</g></svg>';
}
