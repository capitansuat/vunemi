import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {setLocale} from '@vunemi/i18n';
import {CallCard} from '../../src/renderer/src/components/CallCard.js';
import type {CallView} from '../../src/renderer/src/lib/fold.js';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}));
it('presents concrete mutation target with fresh single-call approval controls',()=>{
 setLocale('tr');const call:CallView={requestId:'fresh-request',callId:'c',tool:'desktop_background_document',args:{path:'/tmp/report.txt',text:'Hello'},actionClass:'outbound',status:'awaiting',preview:'Open, append and save /tmp/report.txt'};
 const html=renderToStaticMarkup(<CallCard call={call}/>);
 expect(html).toContain('Hedef');expect(html).toContain('report.txt');expect(html).not.toContain('Oturum izni');expect(html).not.toContain('Bu oturumda hep onayla');expect(html).toContain('Reddet');expect(html).not.toContain('autoFocus');
});
it('a resolved action cannot display approval buttons or session grant controls',()=>{
 setLocale('tr');const html=renderToStaticMarkup(<CallCard call={{requestId:'fresh-request',callId:'c',tool:'files_write',args:{path:'/tmp/report.txt'},actionClass:'write-local',status:'ok',output:'saved'}}/>);
 expect(html).not.toContain('Oturum izni');expect(html).not.toContain('Reddet');
});

it('shows the actual Office output destination as target rather than only the source',()=>{
 setLocale('tr');const html=renderToStaticMarkup(<CallCard call={{requestId:'fresh-request',callId:'office-edit',tool:'document_edit',args:{path:'/tmp/source.docx',out:'/tmp/edited.docx'},actionClass:'write-local',status:'awaiting',preview:'Change one amount; preserve original'}}/>);
 expect(html).toContain('/tmp/edited.docx');
});
it('shows declared engine export destinations on the approval card',()=>{
 setLocale('tr');const html=renderToStaticMarkup(<CallCard call={{requestId:'fresh-request',callId:'engine-edit',tool:'sheets_engine_run',args:{inputs:[{name:'in.xlsx',path:'/tmp/source.xlsx'}],outputs:[{name:'out.xlsx',path:'/tmp/edited.xlsx'}]},actionClass:'write-local',status:'awaiting',preview:'Export updated workbook'}}/>);
 expect(html).toContain('/tmp/edited.xlsx');
});

it('shows replacement and backup details with a single-call approval only',()=>{
 setLocale('tr');const html=renderToStaticMarkup(<CallCard call={{requestId:'fresh-request',callId:'replace',tool:'document_edit',args:{path:'/tmp/source.docx',out:'/tmp/source.docx',replaceExisting:true},actionClass:'write-local',status:'awaiting',alwaysAsk:true,preview:'Replace existing Office file: /tmp/source.docx\nBackup original: /tmp/source.before-edit.docx\nChanges: Old → New'}}/>);
 expect(html).toContain('/tmp/source.before-edit.docx');expect(html).toContain('Old → New');expect(html).toContain('Reddet');expect(html).not.toContain('Bu oturumda hep onayla');
});
