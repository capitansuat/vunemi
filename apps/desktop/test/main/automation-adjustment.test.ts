import {it,expect} from 'vitest';
import {AutomationAdjustment} from '../../src/main/automation-adjustment.js';
const owner={runId:'r',requestId:'p'};
it('unapproved or cancelled old edits cannot alter the next identical setup',()=>{
 const a=new AutomationAdjustment();a.set('same',{time:'10:00'},'c',owner);expect(a.take('same','r','c')).toBeUndefined();
 a.set('same',{time:'10:00'},'c',owner);a.settle('c',owner,false);expect(a.take('same','r','c')).toBeUndefined();
});
it('only the exact request decision activates its edit, once, in the same run',()=>{
 const a=new AutomationAdjustment();a.set('same',{time:'10:00'},'c',owner);a.settle('c',{...owner,requestId:'other'},true);expect(a.take('same','r','c')).toBeUndefined();
 a.set('same',{time:'10:00'},'c',owner);a.settle('c',owner,true);expect(a.take('same','next','c')).toBeUndefined();
 a.set('same',{time:'10:00'},'c',owner);a.settle('c',owner,true);expect(a.take('same','r','c')).toEqual({time:'10:00'});expect(a.take('same','r','c')).toBeUndefined();
});

it('an approved edit cannot be borrowed by a different call in the same run',()=>{const a=new AutomationAdjustment();a.set('same',{time:'10:00'},'old',owner);a.settle('old',owner,true);expect(a.take('same','r','new')).toBeUndefined();});
