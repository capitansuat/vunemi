import { t } from '@vunemi/i18n';
import { useStore } from '../store.js';
import { permissionTarget } from '../lib/task-permissions.js';
/** Both surfaces render the same main-owned projection. Details never become authority. */
export function TaskPermissions({taskId,compact=false}:{taskId?:string;compact?:boolean}) {
 useStore(s=>s.locale);
 const snapshot=useStore(s=>s.taskPermissions);
 const error=useStore(s=>s.taskPermissionsError);
 const loadError=useStore(s=>s.taskPermissionsLoadError);
 const busy=useStore(s=>s.taskPermissionRevoking);
 const notice=useStore(s=>s.taskPermissionsNotice);
 const grants=snapshot?.grants.filter(g=>!taskId||g.taskId===taskId)??[];
 const active=grants.filter(g=>g.status==='active').length;
 const rows=<div data-permissions-revision={snapshot?.revision} className="space-y-2 text-[12px]">
  {!grants.length&&<p className="text-muted">{t('taskPermissions.empty')}</p>}
  <ul className="space-y-3">{grants.map(grant=><li key={grant.grantId} className="min-w-0 rounded-lg border border-line p-2.5">
   <p className="text-fg">{t(grant.effect==='file-read'?'taskPermissions.effect.fileRead':'taskPermissions.effect.windowObserve')}</p>
   <p className="selectable whitespace-pre-wrap break-words text-muted"><bdi>{permissionTarget(grant.target)}</bdi></p>
   <p className="text-muted">{t('taskPermissions.remaining',{remaining:grant.remainingUses,max:grant.maxUses})} · {t(grant.status==='active'?'taskPermissions.runDuration':grant.status==='exhausted'?'taskPermissions.exhausted':grant.status==='revoked'?'taskPermissions.revoked':'taskPermissions.expired')}</p>
   {grant.status==='active'&&<button type="button" disabled={Boolean(busy)} aria-busy={busy===grant.grantId} aria-label={t('taskPermissions.revokeTarget',{target:permissionTarget(grant.target)})} onClick={()=>void useStore.getState().revokeTaskPermission(grant.grantId)} className="mt-2 rounded border border-line-strong px-2 py-1 text-fg hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50">{t(busy===grant.grantId?'taskPermissions.revoking':'taskPermissions.revoke')}</button>}
  </li>)}</ul>
  {notice&&<p role="status" aria-live="polite" className="text-muted">{t('taskPermissions.inFlightRead')}</p>}
  {loadError&&<p role="alert" className="text-danger">{t('taskPermissions.loadFailed')} {loadError}</p>}
  {error&&<p role="alert" className="text-danger">{t('taskPermissions.revokeFailed')} {error}</p>}
 </div>;
 if(compact&&!grants.length&&!error&&!loadError)return null;
 return compact?<details className="border-t border-line px-3.5 py-2"><summary className="cursor-pointer rounded text-[12px] text-muted focus-visible:ring-2 focus-visible:ring-ember">{t('taskPermissions.title')} · {active}</summary><div className="mt-2">{rows}</div></details>:<section className="mt-6"><h3 className="mb-2 text-[14px] font-medium text-fg">{t('taskPermissions.title')} · {active}</h3>{rows}</section>;
}
