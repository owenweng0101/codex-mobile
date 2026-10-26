import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import vm from 'node:vm';
const setName=(value,name)=>Object.defineProperty(value,'name',{value:name,configurable:true});

// Exact original projection/subscribe/resync implementation, with only pure
// built-ins and its original debug-name helper in scope. No host entry runs.
const source=readFileSync(new URL('./original-controller-source.txt',import.meta.url),'utf8');
const scope={Map,Set,Error,Date,JSON,Sc:'controller/workspaces',xa:'controller/tasks-index',jN:isDeepStrictEqual,i:setName};
vm.createContext(scope);
vm.runInContext(source+'\nglobalThis.createProjection=pre;',scope);
export const createOriginalControllerProjection=scope.createProjection;
