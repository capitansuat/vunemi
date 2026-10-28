import {expect,it} from 'vitest';
import {tasksFromEvents,type TaskRecord} from '@vunemi/agent-core';
import {assertModelRecoveryAllowed} from '../../src/main/task-recovery.js';

function task():TaskRecord{return tasksFromEvents([
 {type:'run.started',runId:'native',goal:'scheduled document',model:'recipe:textedit.append-save.v1',executionMode:'native-recipe',at:1},
 {type:'run.finished',runId:'native',status:'stopped',detail:'stopped',at:2},
])[0]!;}

it('rejects interrupted native recovery even before any operation was emitted',()=>{
 const native=task();expect(native.executionMode).toBe('native-recipe');
 expect(()=>assertModelRecoveryAllowed(native)).toThrow();
});
it('rejects legacy native recovery identified by its recorded operation',()=>{
 const native=task();delete native.executionMode;
 native.operations.push({runId:'native',callId:'append',tool:'native_recipe_textedit_append_save',actionClass:'outbound',status:'unknown'});
 expect(()=>assertModelRecoveryAllowed(native)).toThrow();
});
it('allows ordinary model task recovery',()=>{
 const ordinary=task();delete ordinary.executionMode;
 expect(()=>assertModelRecoveryAllowed(ordinary)).not.toThrow();
 expect(()=>assertModelRecoveryAllowed(undefined)).not.toThrow();
});
