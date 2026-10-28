import {Helper} from '@vunemi/mac';
import {serveNativeObservations,type ObservationPort} from './server.js';
const parent=(process as unknown as {parentPort?:ObservationPort}).parentPort;
if(!parent)throw Error('The observation coordinator must be started by Vunemi.');
const close=serveNativeObservations(parent,binary=>new Helper(binary));
process.once('disconnect',close);
process.once('exit',close);
process.once('SIGTERM',()=>{close();process.exit(0);});
