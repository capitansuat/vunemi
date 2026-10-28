import {serveNativeExecution} from '../../../src/coordinator-process/native-execution-server.js';
const close=serveNativeExecution({postMessage:message=>process.send?.(message),on:(_event,handler)=>process.on('message',data=>handler({data}))});
process.once('disconnect',()=>{close();process.exit(0);});
