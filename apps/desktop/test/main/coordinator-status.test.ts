import { describe, expect, it } from 'vitest';
import { coordinatorStatus } from '../../src/main/coordinator-status.js';

const metric = (name = 'Vunemi Agent Session', pid = 20) => ({ name, pid, type: 'Utility', creationTime: 1234 });
describe('coordinatorStatus', () => {
  it('reports only exact known utility roles with process birth', () => {
    expect(coordinatorStatus(10, [metric(), metric('Vunemi Native Execution', 21), metric('Vunemi Vault', 22), metric('Other Service', 23), { ...metric(), type: 'Tab' }])).toEqual({mainPid:10,workers:[{role:'session',pid:20,startedAt:1234},{role:'native',pid:21,startedAt:1234},{role:'vault',pid:22,startedAt:1234}]});
    expect(coordinatorStatus(10, [])).toEqual({mainPid:10,workers:[]});
  });
  it('does not leak extra metric fields or retain metric references', () => {
    const value = {...metric(), commandLine:'secret', env:{key:'secret'}, memory:{private:500}};
    const status = coordinatorStatus(10, [value]); value.pid = 99;
    expect(status).toEqual({mainPid:10,workers:[{role:'session',pid:20,startedAt:1234}]});
    expect(JSON.stringify(status)).not.toContain('secret');
  });
  it.each([0,-1,NaN,Infinity,1.5])('rejects invalid main PID %s', pid => {
    expect(() => coordinatorStatus(pid, [])).toThrow('Coordinator diagnostics unavailable.');
  });
  it.each([0,-1,NaN,Infinity,1.5,10])('rejects malformed known child PID %s', pid => {
    expect(() => coordinatorStatus(10, [{...metric(),pid}])).toThrow('Coordinator diagnostics unavailable.');
  });
  it.each([0,-1,NaN,Infinity])('rejects malformed known child creation time %s', creationTime => {
    expect(() => coordinatorStatus(10, [{...metric(),creationTime}])).toThrow('Coordinator diagnostics unavailable.');
  });
  it('fails closed on ambiguous roles and shared PIDs', () => {
    expect(() => coordinatorStatus(10, [metric(),metric('Vunemi Agent Session',21)])).toThrow('Coordinator diagnostics unavailable.');
    expect(() => coordinatorStatus(10, [metric(),metric('Vunemi Native Execution',20)])).toThrow('Coordinator diagnostics unavailable.');
  });
  it('fails closed on malformed metrics containers and entries', () => {
    expect(() => coordinatorStatus(10, null as never)).toThrow('Coordinator diagnostics unavailable.');
    expect(() => coordinatorStatus(10, [null as never])).toThrow('Coordinator diagnostics unavailable.');
  });
});
