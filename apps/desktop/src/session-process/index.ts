import {serveSessionCoordinator,type SessionWorkerPort} from './server.js';
const parent=(process as unknown as {parentPort?:SessionWorkerPort}).parentPort;
if(!parent)throw Error('The session coordinator must be started by Vunemi.');
const close=serveSessionCoordinator(parent);process.once('disconnect',close);process.once('exit',close);process.once('SIGTERM',()=>{close();process.exit(0);});
