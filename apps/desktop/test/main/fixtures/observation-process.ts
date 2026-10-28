import {Helper} from '@vunemi/mac';
import {serveNativeObservations} from '../../../src/coordinator-process/server.js';
const close=serveNativeObservations({postMessage:message=>process.send?.(message),on:(_event,handler)=>process.on('message',data=>handler({data}))},binary=>new Helper(binary));
process.once('disconnect',()=>{close();process.exit(0);});
process.once('SIGTERM',()=>{close();process.exit(0);});
