// In-flight reads only; there is no settled-response TTL and no event/cursor cache.
// Each consumer gets a separate JSON object, just as separate HTTP responses do.
export const INVALIDATE_READS = Symbol('invalidateReadSharing');
export const CATALOG_GENERATION = Symbol('catalogReadGeneration');
const eligible = path => typeof path === 'string' && (
  ['/api/projects', '/api/organize', '/api/models', '/api/status', '/api/threads'].includes(path) ||
  /^\/api\/(threads|history)\?/.test(path)
);
export function shareReadApi(source, {maxPending = 128} = {}) {
  const pending = new Map();
  let catalogGeneration = 0;
  const invalidate = ({catalog = false} = {}) => {pending.clear();if(catalog)catalogGeneration++;};
  return new Proxy(source, {
    get(target, name, receiver) {
      if (name === INVALIDATE_READS) return invalidate;
      if (name === CATALOG_GENERATION) return catalogGeneration;
      if (name === 'get') return (path, options) => {
        if (options?.shareRead === false) {
          const {shareRead, ...rest} = options;
          return target.get(path, rest);
        }
        // AbortSignal ownership, timeouts and all non-default options stay independent.
        if (!eligible(path) || options && Reflect.ownKeys(options).length) return target.get(path, options);
        let entry = pending.get(path);
        if (!entry) {
          entry = Promise.resolve().then(() => target.get(path, options));
          if (pending.size < maxPending) pending.set(path, entry);
          const cleanup = () => { if (pending.get(path) === entry) pending.delete(path); };
          entry.then(cleanup, cleanup);
        }
        return entry.then(value => structuredClone(value));
      };
      const value = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      if (name === 'post') return (...args) => {
        invalidate({catalog:true});
        let result;
        try { result = value.apply(target, args); } catch (error) { invalidate({catalog:true}); throw error; }
        return Promise.resolve(result).finally(() => invalidate({catalog:true}));
      };
      return value.bind(target);
    },
  });
}
