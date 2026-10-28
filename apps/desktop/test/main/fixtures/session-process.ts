import {serveSessionCoordinator} from '../../../src/session-process/server.js';
const close=serveSessionCoordinator({postMessage:message=>process.send?.(message),on:(_event,listener)=>process.on('message',data=>listener({data}))});
process.on('disconnect',()=>{close();process.exit(0);});
