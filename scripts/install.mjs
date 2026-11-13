// Explicit command, never an npm install lifecycle hook.
import {main} from './mobile-services.mjs';
await main('install');
