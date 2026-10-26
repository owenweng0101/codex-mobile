// Discover capabilities through the installed engine so phone and Mac use the
// same catalogs and configuration. No credentials are projected to the page.
export class CapabilityCatalog {
  constructor(core) { this.core = core; this.cache = new Map(); }
  async skills(cwd, force = false) {
    const key = 'skills:' + cwd;
    if (!force && this.cache.get(key)?.expires > Date.now()) return this.cache.get(key).value;
    const result = await this.core.call('skills/list', { cwds: [cwd], forceReload: force });
    const unique = new Map();
    for (const group of result.data || []) for (const skill of group.skills || []) unique.set(skill.path, {
      name: skill.name, path: skill.path, description: skill.interface?.shortDescription || skill.shortDescription || skill.description,
      displayName: skill.interface?.displayName || skill.name, enabled: skill.enabled, scope: skill.scope, pluginId: skill.pluginId,
    });
    const value = { data: [...unique.values()], errors: (result.data || []).flatMap(group => (group.errors || []).map(e => ({ message: e.message }))) };
    this.cache.set(key, { value, expires: Date.now() + 30000 }); return value;
  }
  async plugins(cwd, force = false) {
    const key = 'plugins:' + cwd;
    if (!force && this.cache.get(key)?.expires > Date.now()) return this.cache.get(key).value;
    const result = await this.core.call('plugin/list', { cwds: [cwd], forceRefetch: force });
    const value = { marketplaces: (result.marketplaces || []).map(m => ({ name: m.name, path: m.path, plugins: (m.plugins || []).map(p => ({
      id: p.id, name: p.name, displayName: p.interface?.displayName || p.name, description: p.interface?.shortDescription || p.interface?.longDescription || '', installed: p.installed, enabled: p.enabled,
      availability: p.availability, disabledReason: p.disabledReason, version: p.version || p.localVersion, installPolicy: p.installPolicy,
      mustShowInstallationInterstitial: p.mustShowInstallationInterstitial, website: p.interface?.websiteUrl, privacy: p.interface?.privacyPolicyUrl, terms: p.interface?.termsOfServiceUrl,
    })) })), errors: (result.marketplaceLoadErrors || []).map(e => ({ message: e.message })) };
    this.cache.set(key, { value, expires: Date.now() + 30000 }); return value;
  }
  async handle(path, method, query, data, resolveWorkspace) {
    const cwd = await resolveWorkspace();
    if (path === '/api/skills') {
      const result = await this.skills(cwd, query.get('refresh') === '1');
      if (method === 'GET') return result;
      const skill = result.data.find(s => s.path === data.path);
      if (!skill || typeof data.enabled !== 'boolean') throw new Error('技能不存在或设置无效');
      await this.core.call('skills/config/write', { path: skill.path, enabled: data.enabled });
      this.cache.delete('skills:' + cwd); return { ok: true };
    }
    const result = await this.plugins(cwd, query.get('refresh') === '1');
    if (method === 'GET') {
      const q = (query.get('q') || '').trim().toLocaleLowerCase(), onlyInstalled = query.get('installed') === '1';
      const all = result.marketplaces.flatMap(market => market.plugins.map(plugin => ({ market, plugin })))
        .filter(({ plugin }) => (!onlyInstalled || plugin.installed) && (!q || [plugin.name, plugin.displayName, plugin.description].join(' ').toLocaleLowerCase().includes(q)))
        .sort((a, b) => Number(b.plugin.installed) - Number(a.plugin.installed));
      const offset = Math.max(0, Number(query.get('cursor')) || 0), page = all.slice(offset, offset + 60), grouped = new Map();
      for (const { market, plugin } of page) { if (!grouped.has(market.name)) grouped.set(market.name, { name: market.name, path: market.path, plugins: [] }); grouped.get(market.name).plugins.push(plugin); }
      return { marketplaces: [...grouped.values()], errors: result.errors, total: all.length, nextCursor: offset + 60 < all.length ? String(offset + 60) : null };
    }
    const marketplace = result.marketplaces.find(m => m.name === data.marketplace), plugin = marketplace?.plugins.find(p => p.id === data.id);
    if (!plugin) throw new Error('插件不存在，请刷新插件列表');
    let response;
    if (data.action === 'install') {
      if (plugin.availability && plugin.availability !== 'AVAILABLE') throw new Error('当前账户无法安装此插件');
      if (!data.confirmed) throw new Error('请先查看并确认插件安装信息');
      response = await this.core.call('plugin/install', { pluginName: plugin.name, ...(marketplace.path ? { marketplacePath: marketplace.path } : { remoteMarketplaceName: marketplace.name }) });
    } else if (data.action === 'uninstall') {
      if (!plugin.installed || !data.confirmed) throw new Error('请确认卸载已安装的插件');
      response = await this.core.call('plugin/uninstall', { pluginId: plugin.id });
    } else throw new Error('不支持的插件操作');
    this.cache.clear(); return { ok: true, result: response };
  }
}
