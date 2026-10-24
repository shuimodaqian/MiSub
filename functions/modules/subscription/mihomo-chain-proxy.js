/**
 * Mihomo/Meta 链式代理（dialer-proxy）模型变换
 *
 * 背景：mihomo 已移除 relay 策略组，节点级 `dialer-proxy` 是当前唯一受支持的链式实现方式。
 * 该变换把 ini 模板中的 `custom_chain_proxy` 声明展开为：
 * 1. 为每个节点生成一份带 `dialer-proxy` 的落地副本（副本名带前缀，避免与原始节点重名）；
 * 2. 落地策略组改为选择这些落地副本；
 * 3. 前置策略组保持只引用原始节点，避免 dialer-proxy 环路。
 *
 * 渲染层在所有客户端调用；仅 Mihomo/Meta 生成 dialer-proxy，其他客户端保留普通策略组。
 */

/**
 * 查找策略组，不存在时创建。
 * @param {Object} model - 统一模板模型
 * @param {string} name - 策略组名称
 * @param {string[]} members - 新建时的初始成员
 * @returns {Object} 策略组
 */
function ensureGroup(model, name, members) {
    let group = model.groups.find((item) => item.name === name);
    if (group) {
        if (!Array.isArray(group.members)) group.members = [];
        return group;
    }
    group = { name, type: 'select', members: [...members], options: {} };
    model.groups.push(group);
    return group;
}

const DYNAMIC_MEMBER_OPTION_KEYS = [
    'include-all',
    'include-all-proxies',
    'use',
    'filter',
    'exclude-filter',
];

function removeDynamicMemberOptions(group) {
    group.filters = [];
    DYNAMIC_MEMBER_OPTION_KEYS.forEach((key) => {
        delete group.options?.[key];
    });
}

/**
 * 展开链式代理落地副本。
 * 模板未声明 `custom_chain_proxy` 时原样返回，保证既有模板行为不变。
 * @param {Object} model - 统一模板模型
 * @param {Object} options - 转换选项
 * @param {boolean} options.enableDialerProxy - 是否生成 Mihomo 专属 dialer-proxy 副本
 * @returns {Object} 处理后的模型
 */
export function applyMihomoChainProxy(model, { enableDialerProxy = true } = {}) {
    const chainConfigs = model?.extras?.chainProxy;
    if (!Array.isArray(chainConfigs) || chainConfigs.length === 0) return model;
    if (!Array.isArray(model.proxies) || !Array.isArray(model.groups)) return model;

    // normalizeUnifiedTemplateModel 保留了数组引用。先复制模型，避免重复渲染时不断叠加副本。
    const baseProxies = model.proxies.filter(Boolean).map((proxy) => ({ ...proxy }));
    const namedBaseProxies = baseProxies.filter((proxy) => proxy.name || proxy.tag);
    const baseNames = Array.from(new Set(namedBaseProxies.map((proxy) => proxy.name || proxy.tag)));
    if (baseNames.length === 0) return model;

    model.proxies = baseProxies;
    model.groups = model.groups.filter(Boolean).map((group) => ({
        ...group,
        members: Array.isArray(group.members) ? [...group.members] : [],
        filters: Array.isArray(group.filters) ? [...group.filters] : [],
        options:
            typeof group.options === 'object' && group.options !== null ? { ...group.options } : {},
    }));

    const usedNames = new Set(baseNames);
    const reservedNames = new Set();
    const handledGroups = new Set();
    const landingNames = new Set(
        chainConfigs.map((config) => String(config?.group || '').trim()).filter(Boolean)
    );

    chainConfigs.forEach((config) => {
        const landingName = String(config?.group || '').trim();
        const entryName = String(config?.entry || '').trim();
        if (
            !landingName ||
            !entryName ||
            landingName === entryName ||
            handledGroups.has(landingName) ||
            landingNames.has(entryName)
        ) {
            return;
        }
        handledGroups.add(landingName);

        const prefix =
            typeof config?.prefix === 'string' && config.prefix !== ''
                ? config.prefix
                : `${landingName} - `;
        const entryGroup = ensureGroup(model, entryName, baseNames);
        const landingGroup = ensureGroup(model, landingName, []);

        if (entryGroup.members.length === 0) entryGroup.members = [...baseNames];
        if (!enableDialerProxy) {
            if (landingGroup.members.length === 0) landingGroup.members = [...baseNames];
            return;
        }

        const copies = namedBaseProxies.map((proxy) => {
            const baseName = proxy.name || proxy.tag;
            let name = `${prefix}${baseName}`;
            let suffix = 2;
            while (usedNames.has(name)) {
                name = `${prefix}${baseName} (${suffix++})`;
            }
            usedNames.add(name);
            reservedNames.add(name);
            return { ...proxy, name, 'dialer-proxy': entryName };
        });

        model.proxies.push(...copies);

        landingGroup.type = 'select';
        landingGroup.members = copies.map((proxy) => proxy.name);
        // 成员已物化，移除动态筛选，避免客户端再次纳入其它节点或提供商节点。
        removeDynamicMemberOptions(landingGroup);

        // 前置组只能引用原始节点：引用落地组或落地副本都会形成 dialer-proxy 环路。
        entryGroup.members = entryGroup.members.filter(
            (member) => member !== landingName && !reservedNames.has(member)
        );
        removeDynamicMemberOptions(entryGroup);
    });

    return model;
}
