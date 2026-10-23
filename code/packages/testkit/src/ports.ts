import type { ExecutionPort, ExecutionSnapshot, HostDeliveryPort, HostReceipt, HttpPort, HttpRequest, HttpResponse, OriginBinding } from '@campussec/contracts';
import { ScriptedPort } from './clock.js';

/** No default success or real I/O. Every response, failure and lost reply is explicitly scripted. */
export function createScriptedHttp(){
  const script=new ScriptedPort<HttpRequest,HttpResponse>();
  const port:HttpPort={request:input=>script.invoke(input)};
  return {script,port};
}
export function createScriptedExecution(){
  const start=new ScriptedPort<Parameters<ExecutionPort['start']>[1],ExecutionSnapshot>();
  const inspect=new ScriptedPort<string,ExecutionSnapshot>();
  const abort=new ScriptedPort<string,ExecutionSnapshot>();
  const port:ExecutionPort={start:(_ctx,input)=>start.invoke(input),inspect:(_ctx,runId)=>inspect.invoke(runId),abort:(_ctx,runId)=>abort.invoke(runId)};
  return {port,start,inspect,abort};
}
export function createScriptedDelivery(){
  const binding=new ScriptedPort<string,OriginBinding>();
  const deliver=new ScriptedPort<Parameters<HostDeliveryPort['deliver']>[1],HostReceipt>();
  const reconcile=new ScriptedPort<Parameters<HostDeliveryPort['reconcileDelivery']>[1],{state:'found'|'absent'|'unknown';receipt?:HostReceipt}>();
  const port:HostDeliveryPort={binding:(_ctx,id)=>binding.invoke(id),deliver:(_ctx,input)=>deliver.invoke(input),reconcileDelivery:(_ctx,input)=>reconcile.invoke(input)};
  return {port,binding,deliver,reconcile};
}
