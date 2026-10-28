import {serveNativeExecution} from './native-execution-server.js';
import type {ObservationPort} from './server.js';
const parent=(process as unknown as {parentPort?:ObservationPort}).parentPort;
if(!parent)throw Error('Native execution coordinator must be started by Vunemi.');
const close=serveNativeExecution(parent);process.once('disconnect',close);process.once('exit',close);
