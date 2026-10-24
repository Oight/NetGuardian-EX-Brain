import type {DesktopApi,AuthApi} from '@campussec/contracts';
import {mountWorkbench} from './app.js';
import {mountAuthenticatedWorkbench} from './auth.js';
declare global {interface Window{campusSec?:DesktopApi;campusAuth?:AuthApi;}}
const element=document.getElementById('app')!;
if(window.campusSec&&window.campusAuth){const mounted=mountAuthenticatedWorkbench({element,api:window.campusSec,auth:window.campusAuth});window.addEventListener('pagehide',()=>mounted.unmount(),{once:true});}
else element.textContent='身份桥接不可用，请使用应用的安全启动入口。';
