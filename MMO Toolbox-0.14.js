// ==UserScript==
// @name         MMO Toolbox
// @name:zh-CN   MMO 调试工具箱
// @namespace    ccw.mmo.toolbox
// @version      0.14
// @description  对 CCW 作品运行时的 MMO 消息与云数据进行查看、拦截与编辑
// @description:zh-CN  对 CCW 作品运行时的 MMO 消息与云数据进行查看、拦截与编辑
// @author       Маскировка\Garl404
// @license      MIT
// @match        *://*.ccw.site/*
// @match        *://*.getgandi.com/*
// @grant        none
// @run-at       document-start
// @homepageURL  https://github.com/Garl404/MMO-Tool
// @supportURL   https://github.com/Garl404/MMO-Tool/issues
// @icon         https://m.ccw.site/community/images/logo-ccw.png
// ==/UserScript==

(function () {
    'use strict';

    const LOG = (...a) => console.log('%c[mt]', 'color:#456;font-weight:bold', ...a);
    const ERR = (...a) => console.error('[mt]', ...a);

    const vmState = { final: null, source: null, trace: [] };

    function isVM(o) {
        if (!o || typeof o !== 'object') return false;
        if (Object.prototype.hasOwnProperty.call(o, 'editingTarget')
            && Object.prototype.hasOwnProperty.call(o, 'runtime')) return true;
        if (o.runtime && o.runtime.targets
            && typeof o.runtime.getTargetById === 'function'
            && o.extensionManager) return true;
        return false;
    }

    function fireVM(vm, source) {
        if (vmState.final) return;
        vmState.final = vm;
        vmState.source = source;
        vmState.trace.push(`OK ${source} ${new Date().toLocaleTimeString()}`);
        try { onVMReady(vm); } catch (e) { ERR(e); }
        scheduleRender();
    }

    (function () {
        try {
            const _bind = Function.prototype.bind;
            Function.prototype.bind = function (self, ...args) {
                if (isVM(self)) {
                    Function.prototype.bind = _bind;
                    fireVM(self, 'bind-trap');
                    return _bind.call(this, self, ...args);
                }
                return _bind.call(this, self, ...args);
            };
        } catch (e) { ERR('bind trap', e); }
    })();

    function scanWindowForVM() {
        let w;
        try { w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window; }
        catch (e) { w = window; }
        if (!w || !w.document) return null;

        const direct = [w.vm, w.scratchVm, w.__vm,
            w.eureka && w.eureka.vm, w.eureka && w.eureka.scratchVm];
        for (const c of direct) if (isVM(c)) return c;

        try {
            for (const k of Object.keys(w)) {
                try { if (isVM(w[k])) return w[k]; } catch (e) { }
            }
        } catch (e) { }

        try {
            const els = w.document.querySelectorAll('canvas, [class*="stage"], [class*="player"]');
            for (const el of els) {
                const key = Object.keys(el).find(k =>
                    k.startsWith('__reactInternalInstance') ||
                    k.startsWith('__reactFiber') ||
                    k.startsWith('__reactContainer'));
                if (!key) continue;
                let node = el[key], depth = 0;
                while (node && depth < 100) {
                    const props = node.memoizedProps || (node.stateNode && node.stateNode.props);
                    if (props) {
                        if (isVM(props.vm)) return props.vm;
                        if (props.runtime && props.runtime.targets) return props.vm || props;
                    }
                    node = node.return; depth++;
                }
            }
        } catch (e) { }
        return null;
    }

    let scanCount = 0;
    const scanTimer = setInterval(() => {
        if (vmState.final) { clearInterval(scanTimer); return; }
        scanCount++;
        const vm = scanWindowForVM();
        if (vm) { fireVM(vm, 'window-scan'); clearInterval(scanTimer); return; }
        if (scanCount >= 200) clearInterval(scanTimer);
    }, 300);

    const LS_RULES = '__mmo_toolbox_rules';
    const LS_TEMPLATES = '__mmo_toolbox_templates';

    const state = {
        extensions: new Map(),
        projectData: new Map(),
        userData: new Map(),
        ccwDataExt: null,
        mmoExt: null,
        mmoExtName: null,
        mmoRoom: null,
        messages: [],
        msgSeq: 0,
        rules: loadJSON(LS_RULES, []),
        templates: loadJSON(LS_TEMPLATES, []),
        playerHistory: [],
        lastPlayersKey: '',
        msgFilter: '',
        typeFilter: '',
    };

    function loadJSON(k, dft) {
        try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : dft; }
        catch (e) { return dft; }
    }
    function saveJSON(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { }
    }

    function onVMReady(vm) {
        try {
            const orig = vm.runtime.compilerRegisterExtension;
            if (typeof orig === 'function') {
                vm.runtime.compilerRegisterExtension = function (name, extObj) {
                    try { registerExt(name, extObj); } catch (e) { ERR(e); }
                    return orig.call(this, name, extObj);
                };
                vmState.trace.push('OK 已挂载 compilerRegisterExtension');
            }
        } catch (e) { ERR(e); }

        scanExistingExtensions(vm);
        let tries = 0;
        const t = setInterval(() => {
            tries++;
            scanExistingExtensions(vm);
            if ((state.ccwDataExt && state.mmoExt) || tries >= 40) clearInterval(t);
            scheduleRender();
        }, 1000);
        scheduleRender();
    }

    function scanExistingExtensions(vm) {
        const em = vm.extensionManager;
        if (!em) return;
        const candidates = ['_loadedExtensions', 'loadedExtensions',
            '_extensionInstances', 'extensionInstances', '_extensions', 'extensions'];
        for (const prop of candidates) {
            let m;
            try { m = em[prop]; } catch (e) { continue; }
            if (!m || typeof m !== 'object') continue;
            try {
                if (typeof m.forEach === 'function') {
                    m.forEach((v, k) => {
                        if (v && typeof v === 'object' && !state.extensions.has(k)) registerExt(k, v);
                    });
                } else {
                    for (const k of Object.keys(m)) {
                        const v = m[k];
                        if (v && typeof v === 'object' && !state.extensions.has(k)) registerExt(k, v);
                    }
                }
            } catch (e) { }
        }
    }

    function registerExt(name, extObj) {
        if (state.extensions.has(name)) return;
        state.extensions.set(name, extObj);

        if (typeof extObj._getValueFromProject === 'function'
            || typeof extObj._setValueToProject === 'function'
            || typeof extObj._getValueFromUser === 'function'
            || typeof extObj._setValueToUser === 'function') {
            if (!state.ccwDataExt) {
                state.ccwDataExt = extObj;
                hookCCWData(extObj);
                vmState.trace.push('OK CCWData');
            }
        }

        if (/mmo/i.test(name)
            || typeof extObj.broadcastMsg === 'function'
            || typeof extObj.dispatchNewMessageWithParams === 'function'
            || typeof extObj.joinRoom === 'function') {
            if (!state.mmoExt) {
                state.mmoExt = extObj;
                state.mmoExtName = name;
                hookMMO(extObj);
                vmState.trace.push('OK MMO (' + name + ')');
            }
        }
    }

    function hookCCWData(ext) {
        const wrapGet = (mn, cache) => {
            const fn = ext[mn];
            if (typeof fn !== 'function') return;
            ext[mn] = async function (name) {
                const val = await fn.call(this, name);
                if (!cache.has(name) || cache.get(name) !== val) {
                    cache.set(name, val); scheduleRender();
                }
                return val;
            };
        };
        const wrapSet = (mn, cache) => {
            const fn = ext[mn];
            if (typeof fn !== 'function') return;
            ext[mn] = async function (name, value) {
                cache.set(name, value); scheduleRender();
                return await fn.call(this, name, value);
            };
        };
        wrapGet('_getValueFromProject', state.projectData);
        wrapSet('_setValueToProject', state.projectData);
        wrapGet('_getValueFromUser', state.userData);
        wrapSet('_setValueToUser', state.userData);
    }

    function hookMMO(ext) {
        try { if (ext.currentRoom) state.mmoRoom = ext.currentRoom; } catch (e) { }

        if (typeof ext.dispatchNewMessageWithParams === 'function') {
            const origDispatch = ext.dispatchNewMessageWithParams;
            ext.dispatchNewMessageWithParams = function (session, util) {
                try {
                    const hp = util && util.thread && util.thread.hatParam;
                    if (hp) {
                        const message = {
                            id: ++state.msgSeq,
                            dir: 'in',
                            t: Date.now(),
                            type: hp.type || '',
                            sender: hp.sender,
                            senderUID: hp.senderUID,
                            name: hp.name || '',
                            content: hp.content,
                            rule: null,
                            action: 'pass'
                        };
                        state.messages.push(message);
                        if (state.messages.length > 500) state.messages.shift();

                        const rule = matchRule(message);
                        if (rule) {
                            message.rule = rule.id;
                            if (rule.action === 'drop') {
                                message.action = 'drop';
                                scheduleRender();
                                return false;
                            }
                            if (rule.action === 'replace') {
                                hp.content = rule.replacement;
                                message.action = 'replace';
                                message.modified = rule.replacement;
                            }
                        }
                        scheduleRender();
                    }
                } catch (e) { ERR('拦截 incoming', e); }
                return origDispatch.call(this, session, util);
            };
            vmState.trace.push('OK dispatchNewMessageWithParams');
        }

        ['broadcastMsg', 'sendMsg', 'broadcast', 'sendBroadcast'].forEach(mn => {
            const fn = ext[mn];
            if (typeof fn !== 'function') return;
            ext[mn] = function (...args) {
                try {
                    state.messages.push({
                        id: ++state.msgSeq,
                        dir: 'out',
                        t: Date.now(),
                        method: mn,
                        args: args.map(a => {
                            try { return JSON.parse(JSON.stringify(a)); }
                            catch (e) { return String(a); }
                        })
                    });
                    if (state.messages.length > 500) state.messages.shift();
                    scheduleRender();
                } catch (e) { }
                return fn.apply(this, args);
            };
        });

        setInterval(() => {
            try {
                if (ext.currentRoom) {
                    state.mmoRoom = ext.currentRoom;
                    const players = ext.currentRoom.players || {};
                    const key = Object.keys(players).sort().join(',');
                    if (key !== state.lastPlayersKey) {
                        state.lastPlayersKey = key;
                        state.playerHistory.push({
                            t: Date.now(),
                            list: Object.entries(players).map(([uid, p]) => ({
                                uid,
                                name: p && p.name ? p.name : ''
                            }))
                        });
                        if (state.playerHistory.length > 50) state.playerHistory.shift();
                    }
                }
            } catch (e) { }
        }, 1000);
    }

    function matchRule(msg) {
        for (const r of state.rules) {
            if (!r.enabled) continue;
            if (r.typeMatch && msg.type !== r.typeMatch) continue;
            if (r.contentPattern) {
                try {
                    if (!new RegExp(r.contentPattern).test(String(msg.content == null ? '' : msg.content))) continue;
                } catch (e) { continue; }
            }
            return r;
        }
        return null;
    }

    async function queryValue(scope, key) {
        const ext = state.ccwDataExt;
        if (!ext) return null;
        const mn = scope === 'project' ? '_getValueFromProject' : '_getValueFromUser';
        if (typeof ext[mn] !== 'function') return null;
        try {
            const v = await ext[mn].call(ext, key);
            (scope === 'project' ? state.projectData : state.userData).set(key, v);
            return v;
        } catch (e) { return null; }
    }
    async function setValue(scope, key, value) {
        const ext = state.ccwDataExt;
        if (!ext) return false;
        const mn = scope === 'project' ? '_setValueToProject' : '_setValueToUser';
        if (typeof ext[mn] !== 'function') return false;
        try {
            await ext[mn].call(ext, key, value);
            (scope === 'project' ? state.projectData : state.userData).set(key, value);
            return true;
        } catch (e) { return false; }
    }

    let panel, toggleBtn, bodyEl, statsEl;
    let currentTab = 'msg';

    function whenDocReady(fn) {
        if (document.documentElement) { fn(); return; }
        const obs = new MutationObserver(() => {
            if (document.documentElement) { obs.disconnect(); fn(); }
        });
        obs.observe(document, { childList: true, subtree: true });
    }

    whenDocReady(() => {
        const styleEl = document.createElement('style');
        styleEl.textContent = `
            #mt-panel{position:fixed;top:70px;right:18px;width:400px;max-height:640px;
                background:#f6f6f6;border:1px solid #999;border-radius:3px;
                box-shadow:0 4px 14px rgba(0,0,0,.18);
                font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
                font-size:12px;color:#222;z-index:2147483647;
                display:flex;flex-direction:column;overflow:hidden}
            #mt-panel.mt-hidden{display:none}
            #mt-header{display:flex;justify-content:space-between;align-items:center;
                padding:5px 10px;background:#3d4a5c;color:#e8ecf0;
                cursor:move;user-select:none;flex-shrink:0;border-bottom:1px solid #2a3440}
            #mt-header .tt{font-weight:600;font-size:12px;letter-spacing:.5px}
            #mt-header .ac{display:flex;gap:3px}
            #mt-header button{background:transparent;border:1px solid #6b7a8c;
                color:#e8ecf0;border-radius:2px;cursor:pointer;font-size:11px;
                padding:2px 8px}
            #mt-header button:hover{background:#4d5a6c}
            #mt-stats{padding:3px 10px;font-size:10px;color:#666;
                background:#ececec;border-bottom:1px solid #d4d4d4;
                flex-shrink:0;font-family:Menlo,Consolas,monospace;
                word-break:break-all;line-height:1.5}
            #mt-tabs{display:flex;background:#e2e2e2;border-bottom:1px solid #ccc;
                flex-shrink:0}
            #mt-tabs button{flex:1;padding:6px 2px;border:none;background:transparent;
                cursor:pointer;font-size:11px;color:#555;
                border-right:1px solid #ccc;font-family:inherit}
            #mt-tabs button:last-child{border-right:none}
            #mt-tabs button.active{background:#f6f6f6;color:#1f4e79;font-weight:600}
            #mt-tabs button:hover:not(.active){background:#d6d6d6}
            #mt-body{padding:8px;overflow-y:auto;flex:1;min-height:0}
            .mt-block{background:#fff;border:1px solid #ddd;border-radius:3px;
                padding:6px 8px;margin-bottom:6px}
            .mt-block .h{font-weight:600;color:#1f4e79;font-size:11px;
                margin-bottom:4px;word-break:break-all}
            .mt-block .sub{font-size:10px;color:#999;margin-bottom:4px}
            .mt-row{display:flex;gap:3px;align-items:center}
            .mt-row input,.mt-row select{flex:1;padding:3px 5px;border:1px solid #ccc;
                border-radius:2px;font-size:11px;font-family:Menlo,Consolas,monospace;
                min-width:0;background:#fafafa}
            .mt-row select{flex:0 0 auto;width:76px}
            .mt-row button{padding:3px 8px;border:1px solid #888;border-radius:2px;
                background:#e6e6e6;cursor:pointer;font-size:11px;color:#222;
                white-space:nowrap;font-family:inherit}
            .mt-row button:hover{background:#d4d4d4}
            .mt-empty{text-align:center;color:#999;padding:20px 0;font-size:11px;
                line-height:1.6}
            .mt-leaf{display:flex;gap:4px;align-items:center;margin-top:3px}
            .mt-leaf .lbl{flex:0 0 96px;font-size:10px;color:#666;
                font-family:Menlo,Consolas,monospace;word-break:break-all}
            .mt-leaf input{flex:1;padding:2px 5px;border:1px solid #ddd;
                border-radius:2px;font-size:11px;font-family:Menlo,Consolas,monospace;
                min-width:0;background:#fafafa}
            .mt-leaf button{padding:2px 6px;font-size:10px;border:1px solid #999;
                border-radius:2px;background:#e6e6e6;cursor:pointer;font-family:inherit}
            .mt-leaf button:hover{background:#d4d4d4}
            .mt-msg{border-left:3px solid #ccc;padding:4px 6px;margin-bottom:4px;
                background:#fbfbfb;font-size:11px}
            .mt-msg.in{border-left-color:#2e7d32}
            .mt-msg.out{border-left-color:#c28b00}
            .mt-msg.drop{border-left-color:#c62828;opacity:.7}
            .mt-msg.mod{border-left-color:#1565c0}
            .mt-msg .hd{display:flex;justify-content:space-between;
                font-family:Menlo,Consolas,monospace;font-size:10px;color:#666}
            .mt-msg .bd{margin-top:2px;font-family:Menlo,Consolas,monospace;
                font-size:10px;color:#333;word-break:break-all}
            .mt-msg .badge{display:inline-block;padding:0 4px;border-radius:2px;
                background:#e0e0e0;color:#333;font-size:9px;margin-left:4px}
            .mt-rule{background:#f9f9f9;border:1px solid #e0e0e0;border-radius:2px;
                padding:4px 6px;margin-bottom:4px;font-size:10px}
            .mt-rule .rr{display:flex;gap:3px;align-items:center;margin-bottom:3px}
            .mt-rule input[type=text]{flex:1;padding:2px 4px;border:1px solid #ccc;
                border-radius:2px;font-size:10px;font-family:Menlo,Consolas,monospace;
                min-width:0}
            .mt-rule select{padding:2px 3px;border:1px solid #ccc;border-radius:2px;
                font-size:10px;background:#fff}
            .mt-rule button{padding:1px 5px;border:1px solid #999;border-radius:2px;
                background:#e6e6e6;cursor:pointer;font-size:10px;font-family:inherit}
            .mt-rule button:hover{background:#d4d4d4}
            .mt-method{display:inline-block;margin:2px 3px 2px 0;padding:2px 7px;
                font-size:10px;border:1px solid #999;border-radius:2px;
                background:#eaeaea;cursor:pointer;font-family:Menlo,Consolas,monospace}
            .mt-method:hover{background:#d4d4d4}
            .mt-toolbar{display:flex;gap:3px;margin-bottom:6px}
            .mt-toolbar input{flex:1;padding:3px 6px;border:1px solid #ccc;
                border-radius:2px;font-size:11px;font-family:Menlo,Consolas,monospace}
            .mt-toolbar button{padding:3px 10px;border:1px solid #888;
                border-radius:2px;background:#e6e6e6;cursor:pointer;font-size:11px;
                font-family:inherit}
            .mt-toolbar button:hover{background:#d4d4d4}
            .mt-fold{cursor:pointer;user-select:none;font-weight:600;color:#1f4e79;
                font-size:11px;padding:3px 0}
            .mt-fold:hover{text-decoration:underline}
            #mt-toggle{position:fixed;top:70px;right:18px;width:34px;height:34px;
                background:#3d4a5c;color:#e8ecf0;border:1px solid #2a3440;
                border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.2);
                cursor:pointer;z-index:2147483646;display:flex;
                align-items:center;justify-content:center;font-size:15px;
                user-select:none;font-family:Menlo,Consolas,monospace}
            #mt-toggle.mt-hidden{display:none}
            #mt-toggle:hover{background:#4d5a6c}
        `;
        document.documentElement.appendChild(styleEl);

        panel = document.createElement('div');
        panel.id = 'mt-panel';
        panel.className = 'mt-hidden';
        panel.innerHTML = `
            <div id="mt-header">
                <span class="tt">MMO Toolbox</span>
                <div class="ac">
                    <button id="mt-refresh">⟳</button>
                    <button id="mt-min">收起</button>
                </div>
            </div>
            <div id="mt-stats">等待 VM</div>
            <div id="mt-tabs">
                <button data-tab="msg" class="active">消息</button>
                <button data-tab="room">房间</button>
                <button data-tab="cast">广播</button>
                <button data-tab="data">数据</button>
                <button data-tab="state">状态</button>
            </div>
            <div id="mt-body"><div class="mt-empty">加载中</div></div>
        `;
        document.documentElement.appendChild(panel);

        toggleBtn = document.createElement('div');
        toggleBtn.id = 'mt-toggle';
        toggleBtn.textContent = '☁';
        toggleBtn.title = '打开 MMO Toolbox (Ctrl+Shift+M)';
        document.documentElement.appendChild(toggleBtn);

        (function () {
            const header = panel.querySelector('#mt-header');
            let dragging = false, ox = 0, oy = 0;
            header.addEventListener('mousedown', e => {
                if (e.target.tagName === 'BUTTON') return;
                dragging = true;
                const r = panel.getBoundingClientRect();
                ox = e.clientX - r.left; oy = e.clientY - r.top;
            });
            document.addEventListener('mousemove', e => {
                if (!dragging) return;
                panel.style.left = (e.clientX - ox) + 'px';
                panel.style.top = (e.clientY - oy) + 'px';
                panel.style.right = 'auto';
            });
            document.addEventListener('mouseup', () => { dragging = false; });
        })();

        bodyEl = panel.querySelector('#mt-body');
        statsEl = panel.querySelector('#mt-stats');

        function showPanel() { panel.classList.remove('mt-hidden'); toggleBtn.classList.add('mt-hidden'); }
        function hidePanel() { panel.classList.add('mt-hidden'); toggleBtn.classList.remove('mt-hidden'); }

        panel.querySelector('#mt-min').addEventListener('click', hidePanel);
        toggleBtn.addEventListener('click', () => { showPanel(); render(); });
        panel.querySelector('#mt-refresh').addEventListener('click', () => {
            if (!vmState.final) {
                const vm = scanWindowForVM();
                if (vm) fireVM(vm, 'manual-rescan');
            }
            render();
        });
        panel.querySelectorAll('#mt-tabs button').forEach(btn => {
            btn.addEventListener('click', () => {
                currentTab = btn.dataset.tab;
                panel.querySelectorAll('#mt-tabs button').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
                render();
            });
        });

        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') {
                e.preventDefault();
                if (panel.classList.contains('mt-hidden')) showPanel();
                else hidePanel();
                render();
            }
        });

        const waitShow = setInterval(() => {
            if (vmState.final) { clearInterval(waitShow); showPanel(); render(); }
        }, 200);
        setTimeout(() => { if (!vmState.final) { showPanel(); render(); } }, 5000);

        render();
    });

    let renderTimer = null;
    function scheduleRender() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => { renderTimer = null; render(); }, 250);
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function render() {
        if (!statsEl || !bodyEl) return;
        const room = state.mmoRoom;
        const roomPart = room ? ` room=${room.roomId || room.id || '?'} online=${room.onlineCount != null ? room.onlineCount : '?'}` : '';
        statsEl.textContent = `VM=${vmState.final ? 'ok' : 'no'} ext=${state.extensions.size} msg=${state.messages.length} proj=${state.projectData.size} user=${state.userData.size}${roomPart}`;

        if (currentTab === 'state') return renderState();
        if (!vmState.final) {
            bodyEl.innerHTML = '';
            bodyEl.appendChild(el('div', 'mt-empty', '未捕获到 VM，请查看状态标签'));
            return;
        }
        if (currentTab === 'msg') return renderMessages();
        if (currentTab === 'room') return renderRoom();
        if (currentTab === 'cast') return renderCast();
        if (currentTab === 'data') return renderData();
    }

    function renderState() {
        bodyEl.innerHTML = '';
        const b1 = el('div', 'mt-block');
        b1.appendChild(el('div', 'h', '捕获状态'));
        b1.appendChild(el('div', 'sub', 'VM: ' + (vmState.final ? '已捕获' : '未捕获')));
        b1.appendChild(el('div', 'sub', '来源: ' + (vmState.source || '等待中')));
        bodyEl.appendChild(b1);

        const b2 = el('div', 'mt-block');
        b2.appendChild(el('div', 'h', '捕获路径'));
        vmState.trace.forEach(line => {
            const d = el('div');
            d.style.fontSize = '10px';
            d.style.fontFamily = 'Menlo,Consolas,monospace';
            d.style.color = line.startsWith('OK') ? '#2e7d32' : '#999';
            d.textContent = line;
            b2.appendChild(d);
        });
        bodyEl.appendChild(b2);

        if (state.extensions.size) {
            const b3 = el('div', 'mt-block');
            b3.appendChild(el('div', 'h', '已捕获扩展 (' + state.extensions.size + ')'));
            state.extensions.forEach((extObj, name) => {
                const fold = el('div', 'mt-fold', name + '  [展开]');
                const detail = el('div');
                detail.style.display = 'none';
                let built = false;
                fold.addEventListener('click', () => {
                    const show = detail.style.display === 'none';
                    detail.style.display = show ? 'block' : 'none';
                    fold.textContent = name + (show ? '  [收起]' : '  [展开]');
                    if (show && !built) {
                        built = true;
                        buildMethodList(detail, extObj, name);
                    }
                });
                b3.appendChild(fold);
                b3.appendChild(detail);
            });
            bodyEl.appendChild(b3);
        }

        const btn = el('button', null, '手动重扫');
        btn.style.cssText = 'padding:5px 12px;border:1px solid #888;border-radius:2px;background:#e6e6e6;cursor:pointer;font-size:11px;font-family:inherit';
        btn.addEventListener('click', () => {
            const vm = scanWindowForVM();
            if (vm) fireVM(vm, 'manual-scan');
            else { vmState.trace.push('NO 手动扫描无结果'); render(); }
        });
        bodyEl.appendChild(btn);
    }

    function buildMethodList(container, extObj, extName) {
        const methods = new Set();
        for (const k of Object.keys(extObj)) {
            try { if (typeof extObj[k] === 'function') methods.add(k); } catch (e) { }
        }
        let proto = Object.getPrototypeOf(extObj), depth = 0;
        while (proto && proto !== Object.prototype && depth < 5) {
            for (const k of Object.getOwnPropertyNames(proto)) {
                if (k === 'constructor') continue;
                try { if (typeof extObj[k] === 'function') methods.add(k); } catch (e) { }
            }
            proto = Object.getPrototypeOf(proto); depth++;
        }
        const meta = el('div', 'sub', methods.size + ' 个方法，点击调用');
        container.appendChild(meta);
        const list = el('div');
        list.style.maxHeight = '220px';
        list.style.overflowY = 'auto';
        Array.from(methods).sort().forEach(m => {
            const btn = el('span', 'mt-method', m);
            btn.addEventListener('click', () => {
                const argsStr = prompt(`调用 ${extName}.${m}\n\n参数为 JSON 数组，例如：\n  []\n  ["hello"]\n  [{"type":"chat","content":"hi"}]`, '[]');
                if (argsStr === null) return;
                try {
                    const args = JSON.parse(argsStr);
                    if (!Array.isArray(args)) throw new Error('参数必须是 JSON 数组');
                    const r = extObj[m].apply(extObj, args);
                    if (r && typeof r.then === 'function') {
                        r.then(v => alert('返回:\n' + safeStringify(v)))
                            .catch(e => alert('失败: ' + e.message));
                    } else {
                        alert('返回:\n' + safeStringify(r));
                    }
                } catch (e) { alert('调用失败: ' + e.message); }
            });
            list.appendChild(btn);
        });
        container.appendChild(list);
    }

    function safeStringify(v) {
        try { return JSON.stringify(v, null, 2); }
        catch (e) { return String(v); }
    }

    function renderMessages() {
        bodyEl.innerHTML = '';

        const tb = el('div', 'mt-toolbar');
        const filterInp = el('input');
        filterInp.placeholder = '过滤内容';
        filterInp.value = state.msgFilter;
        filterInp.addEventListener('input', () => { state.msgFilter = filterInp.value; render(); });
        const typeSel = el('select');
        ['全部类型', '仅 incoming', '仅 outgoing'].forEach((t, i) => {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = t;
            if ((i === 0 && !state.typeFilter) || (i === 1 && state.typeFilter === 'in') || (i === 2 && state.typeFilter === 'out')) o.selected = true;
            typeSel.appendChild(o);
        });
        typeSel.addEventListener('change', () => {
            const v = typeSel.value;
            state.typeFilter = v === '1' ? 'in' : (v === '2' ? 'out' : '');
            render();
        });
        const clearBtn = el('button', null, '清空');
        clearBtn.addEventListener('click', () => { state.messages = []; render(); });
        const expBtn = el('button', null, '导出');
        expBtn.addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state.messages, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'mmo-messages.json';
            a.click();
        });
        tb.appendChild(filterInp);
        tb.appendChild(typeSel);
        tb.appendChild(clearBtn);
        tb.appendChild(expBtn);
        bodyEl.appendChild(tb);

        const ruleBlock = el('div', 'mt-block');
        const ruleFold = el('div', 'mt-fold', `拦截规则 (${state.rules.length})  [展开]`);
        const ruleBody = el('div');
        ruleBody.style.display = 'none';
        let ruleBuilt = false;
        ruleFold.addEventListener('click', () => {
            const show = ruleBody.style.display === 'none';
            ruleBody.style.display = show ? 'block' : 'none';
            ruleFold.textContent = `拦截规则 (${state.rules.length})  ${show ? '[收起]' : '[展开]'}`;
            if (show && !ruleBuilt) { ruleBuilt = true; buildRuleUI(ruleBody); }
        });
        ruleBlock.appendChild(ruleFold);
        ruleBlock.appendChild(ruleBody);
        bodyEl.appendChild(ruleBlock);

        const list = el('div');
        let msgs = state.messages.slice().reverse();
        if (state.typeFilter) msgs = msgs.filter(m => m.dir === state.typeFilter);
        if (state.msgFilter) {
            const f = state.msgFilter.toLowerCase();
            msgs = msgs.filter(m => {
                const t = (m.type || '') + ' ' + (m.name || '') + ' ' + safeStringify(m.content || m.args || '');
                return t.toLowerCase().includes(f);
            });
        }
        if (msgs.length === 0) {
            list.appendChild(el('div', 'mt-empty', '暂无消息'));
        } else {
            msgs.slice(0, 200).forEach(m => {
                if (m.dir === 'in') list.appendChild(buildInMsg(m));
                else list.appendChild(buildOutMsg(m));
            });
        }
        bodyEl.appendChild(list);
    }

    function buildInMsg(m) {
        const d = el('div', 'mt-msg in');
        if (m.action === 'drop') d.className = 'mt-msg drop';
        else if (m.action === 'replace') d.className = 'mt-msg mod';

        const hd = el('div', 'hd');
        const left = el('span');
        left.textContent = `[in] ${m.type}`;
        if (m.name) left.textContent += `  <- ${m.name}`;
        if (m.rule) {
            const b = el('span', 'badge', '规则 ' + m.rule);
            left.appendChild(b);
        }
        const right = el('span');
        right.textContent = new Date(m.t).toLocaleTimeString();
        hd.appendChild(left);
        hd.appendChild(right);
        d.appendChild(hd);

        if (m.content != null && m.content !== '') {
            const bd = el('div', 'bd');
            bd.textContent = 'content: ' + (typeof m.content === 'string' ? m.content : safeStringify(m.content));
            d.appendChild(bd);
        }
        if (m.senderUID) {
            const bd2 = el('div', 'bd', 'uid: ' + m.senderUID);
            d.appendChild(bd2);
        }
        return d;
    }

    function buildOutMsg(m) {
        const d = el('div', 'mt-msg out');
        const hd = el('div', 'hd');
        const left = el('span', null, '[out] ' + m.method);
        const right = el('span', null, new Date(m.t).toLocaleTimeString());
        hd.appendChild(left);
        hd.appendChild(right);
        d.appendChild(hd);
        const bd = el('div', 'bd', m.args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' '));
        d.appendChild(bd);
        return d;
    }

    function buildRuleUI(container) {
        const list = el('div');
        state.rules.forEach((r, idx) => {
            list.appendChild(buildRuleRow(r, idx, container));
        });
        container.appendChild(list);

        const addBtn = el('button', null, '+ 新建规则');
        addBtn.style.cssText = 'padding:4px 10px;border:1px solid #888;border-radius:2px;background:#e6e6e6;cursor:pointer;font-size:11px;margin-top:4px;font-family:inherit';
        addBtn.addEventListener('click', () => {
            state.rules.push({
                id: 'r' + Date.now().toString(36),
                enabled: true,
                typeMatch: '',
                contentPattern: '',
                action: 'drop',
                replacement: ''
            });
            saveJSON(LS_RULES, state.rules);
            refreshRuleUI(container);
        });
        container.appendChild(addBtn);
    }

    function refreshRuleUI(container) {
        container.innerHTML = '';
        const list = el('div');
        state.rules.forEach((r, idx) => list.appendChild(buildRuleRow(r, idx, container)));
        container.appendChild(list);
        const addBtn = el('button', null, '+ 新建规则');
        addBtn.style.cssText = 'padding:4px 10px;border:1px solid #888;border-radius:2px;background:#e6e6e6;cursor:pointer;font-size:11px;margin-top:4px;font-family:inherit';
        addBtn.addEventListener('click', () => {
            state.rules.push({
                id: 'r' + Date.now().toString(36),
                enabled: true,
                typeMatch: '',
                contentPattern: '',
                action: 'drop',
                replacement: ''
            });
            saveJSON(LS_RULES, state.rules);
            refreshRuleUI(container);
        });
        container.appendChild(addBtn);
    }

    function buildRuleRow(r, idx, container) {
        const box = el('div', 'mt-rule');

        const r1 = el('div', 'rr');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = r.enabled;
        cb.addEventListener('change', () => { r.enabled = cb.checked; saveJSON(LS_RULES, state.rules); });
        const typeInp = el('input');
        typeInp.type = 'text';
        typeInp.placeholder = 'type 精确匹配（留空=任意）';
        typeInp.value = r.typeMatch || '';
        typeInp.addEventListener('input', () => { r.typeMatch = typeInp.value; saveJSON(LS_RULES, state.rules); });
        const delBtn = el('button', null, '删除');
        delBtn.addEventListener('click', () => {
            state.rules.splice(idx, 1);
            saveJSON(LS_RULES, state.rules);
            refreshRuleUI(container);
        });
        r1.appendChild(cb);
        r1.appendChild(typeInp);
        r1.appendChild(delBtn);
        box.appendChild(r1);

        const r2 = el('div', 'rr');
        const patInp = el('input');
        patInp.type = 'text';
        patInp.placeholder = 'content 正则（留空=任意）';
        patInp.value = r.contentPattern || '';
        patInp.addEventListener('input', () => { r.contentPattern = patInp.value; saveJSON(LS_RULES, state.rules); });
        r2.appendChild(patInp);
        box.appendChild(r2);

        const r3 = el('div', 'rr');
        const actSel = document.createElement('select');
        [['drop', '丢弃'], ['replace', '替换内容']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (r.action === v) o.selected = true;
            actSel.appendChild(o);
        });
        actSel.addEventListener('change', () => { r.action = actSel.value; saveJSON(LS_RULES, state.rules); refreshRuleUI(container); });
        r3.appendChild(actSel);
        if (r.action === 'replace') {
            const repInp = el('input');
            repInp.type = 'text';
            repInp.placeholder = '替换为...';
            repInp.value = r.replacement || '';
            repInp.addEventListener('input', () => { r.replacement = repInp.value; saveJSON(LS_RULES, state.rules); });
            r3.appendChild(repInp);
        }
        box.appendChild(r3);
        return box;
    }

    function renderRoom() {
        bodyEl.innerHTML = '';
        if (!state.mmoRoom) {
            bodyEl.appendChild(el('div', 'mt-empty', '未加入房间'));
            return;
        }
        const room = state.mmoRoom;

        const b = el('div', 'mt-block');
        b.appendChild(el('div', 'h', '房间字段（本地修改可能被服务器覆盖）'));
        const simpleKeys = [];
        for (const [k, v] of Object.entries(room)) {
            if (v === null || typeof v !== 'object') simpleKeys.push([k, v]);
        }
        simpleKeys.forEach(([k, v]) => b.appendChild(buildEditableLeaf(room, k, v)));
        bodyEl.appendChild(b);

        if (room.players && typeof room.players === 'object') {
            const pb = el('div', 'mt-block');
            const uids = Object.keys(room.players);
            pb.appendChild(el('div', 'h', `玩家 (${uids.length})`));
            uids.forEach(uid => {
                pb.appendChild(buildPlayerEntry(uid, room.players[uid]));
            });
            bodyEl.appendChild(pb);
        }

        if (state.playerHistory.length) {
            const hb = el('div', 'mt-block');
            hb.appendChild(el('div', 'h', '玩家变化历史'));
            state.playerHistory.slice().reverse().slice(0, 20).forEach(h => {
                const d = el('div', 'sub');
                d.style.fontFamily = 'Menlo,Consolas,monospace';
                const names = h.list.map(p => p.name || p.uid.slice(0, 6)).join(', ') || '(空)';
                d.textContent = `${new Date(h.t).toLocaleTimeString()}  ${names}`;
                hb.appendChild(d);
            });
            bodyEl.appendChild(hb);
        }
    }

    function buildEditableLeaf(obj, key, value) {
        const row = el('div', 'mt-leaf');
        const lbl = el('span', 'lbl', key);
        row.appendChild(lbl);
        const inp = el('input');
        inp.type = 'text';
        inp.value = String(value);
        row.appendChild(inp);
        const btn = el('button', null, '写入');
        btn.addEventListener('click', () => {
            let v = inp.value;
            const t = typeof value;
            if (t === 'number') { const n = Number(v); if (!Number.isNaN(n)) v = n; }
            else if (t === 'boolean') v = (v === 'true' || v === '1');
            try {
                obj[key] = v;
                btn.textContent = '成功';
            } catch (e) { btn.textContent = '失败'; }
            setTimeout(() => { btn.textContent = '写入'; }, 700);
        });
        row.appendChild(btn);
        return row;
    }

    function buildPlayerEntry(uid, p) {
        const entry = el('div');
        entry.style.marginTop = '4px';
        entry.style.padding = '3px 5px';
        entry.style.background = '#fafafa';
        entry.style.border = '1px solid #eee';
        entry.style.borderRadius = '2px';

        const header = el('div', 'mt-fold');
        const name = p && p.name ? p.name : '(无名)';
        header.textContent = name + '  [' + String(uid).slice(0, 8) + ']';
        entry.appendChild(header);

        const detail = el('div');
        detail.style.display = 'none';
        entry.appendChild(detail);

        let built = false;
        header.addEventListener('click', () => {
            const show = detail.style.display === 'none';
            detail.style.display = show ? 'block' : 'none';
            if (show && !built) {
                built = true;
                if (p && typeof p === 'object') {
                    for (const [k, v] of Object.entries(p)) {
                        if (v === null || typeof v !== 'object') {
                            detail.appendChild(buildEditableLeaf(p, k, v));
                        }
                    }
                    for (const [k, v] of Object.entries(p)) {
                        if (v !== null && typeof v === 'object') {
                            const d = el('div', 'sub');
                            d.style.fontFamily = 'Menlo,Consolas,monospace';
                            const s = safeStringify(v);
                            d.textContent = k + ': ' + (s.length > 90 ? s.slice(0, 90) + '...' : s);
                            detail.appendChild(d);
                        }
                    }
                }
            }
        });
        return entry;
    }

    function renderCast() {
        bodyEl.innerHTML = '';
        const ext = state.mmoExt;
        if (!ext) {
            bodyEl.appendChild(el('div', 'mt-empty', '未检测到 MMO'));
            return;
        }

        const send = el('div', 'mt-block');
        send.appendChild(el('div', 'h', '发送广播'));
        const r1 = el('div', 'mt-row');
        r1.style.marginBottom = '4px';
        const typeLbl = el('span', null, 'type');
        typeLbl.style.cssText = 'font-size:10px;color:#666;font-family:Menlo,Consolas,monospace;';
        const typeInp = el('input');
        typeInp.type = 'text';
        typeInp.value = 'chat';
        typeInp.placeholder = 'chat';
        r1.appendChild(typeLbl);
        r1.appendChild(typeInp);
        send.appendChild(r1);

        const r2 = el('div', 'mt-row');
        const contentInp = el('input');
        contentInp.type = 'text';
        contentInp.placeholder = '消息内容';
        const sendBtn = el('button', null, '发送');
        sendBtn.addEventListener('click', () => {
            const type = typeInp.value.trim() || 'chat';
            const content = contentInp.value;
            let ok = false;
            try {
                if (typeof ext.broadcastMsg === 'function') { ext.broadcastMsg({ type, content }); ok = true; }
                else if (typeof ext.sendMsg === 'function') { ext.sendMsg({ type, content }); ok = true; }
                else if (typeof ext.broadcast === 'function') { ext.broadcast({ type, content }); ok = true; }
            } catch (e) { ERR(e); }
            sendBtn.textContent = ok ? '成功' : '无可用方法';
            setTimeout(() => { sendBtn.textContent = '发送'; }, 800);
            if (ok) contentInp.value = '';
        });
        const saveTplBtn = el('button', null, '存为模板');
        saveTplBtn.addEventListener('click', () => {
            state.templates.push({
                type: typeInp.value.trim() || 'chat',
                content: contentInp.value
            });
            saveJSON(LS_TEMPLATES, state.templates);
            render();
        });
        r2.appendChild(contentInp);
        r2.appendChild(sendBtn);
        r2.appendChild(saveTplBtn);
        send.appendChild(r2);
        bodyEl.appendChild(send);

        const tplBlock = el('div', 'mt-block');
        tplBlock.appendChild(el('div', 'h', `快捷模板 (${state.templates.length})`));
        if (state.templates.length === 0) {
            tplBlock.appendChild(el('div', 'sub', '暂无模板，发送后点"存为模板"保存'));
        } else {
            state.templates.forEach((t, idx) => {
                const row = el('div', 'mt-row');
                row.style.marginBottom = '3px';
                const info = el('span', null, `[${t.type}] ${t.content}`);
                info.style.cssText = 'flex:1;font-size:11px;font-family:Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                info.title = `[${t.type}] ${t.content}`;
                const sBtn = el('button', null, '发送');
                sBtn.addEventListener('click', () => {
                    let ok = false;
                    try {
                        if (typeof ext.broadcastMsg === 'function') { ext.broadcastMsg({ type: t.type, content: t.content }); ok = true; }
                        else if (typeof ext.sendMsg === 'function') { ext.sendMsg({ type: t.type, content: t.content }); ok = true; }
                    } catch (e) { }
                    sBtn.textContent = ok ? '成功' : '失败';
                    setTimeout(() => { sBtn.textContent = '发送'; }, 800);
                });
                const dBtn = el('button', null, '删除');
                dBtn.addEventListener('click', () => {
                    state.templates.splice(idx, 1);
                    saveJSON(LS_TEMPLATES, state.templates);
                    render();
                });
                row.appendChild(info);
                row.appendChild(sBtn);
                row.appendChild(dBtn);
                tplBlock.appendChild(row);
            });
        }
        bodyEl.appendChild(tplBlock);

        const inj = el('div', 'mt-block');
        inj.appendChild(el('div', 'h', '注入 incoming 消息'));
        inj.appendChild(el('div', 'sub', '尝试直接触发作品的 onMessageHandlers，模拟其他玩家发来的消息'));

        const i1 = el('div', 'mt-row');
        i1.style.marginBottom = '3px';
        const injType = el('input');
        injType.placeholder = 'type 例如 syscmd.newPlayerAdded';
        i1.appendChild(injType);
        inj.appendChild(i1);

        const i2 = el('div', 'mt-row');
        i2.style.marginBottom = '3px';
        const injName = el('input');
        injName.placeholder = '伪造发送者名字';
        const injUID = el('input');
        injUID.placeholder = '伪造 uid';
        i2.appendChild(injName);
        i2.appendChild(injUID);
        inj.appendChild(i2);

        const i3 = el('div', 'mt-row');
        const injContent = el('input');
        injContent.placeholder = 'content';
        const injBtn = el('button', null, '注入');
        injBtn.addEventListener('click', () => {
            const type = injType.value.trim();
            if (!type) return;
            const payload = {
                type,
                content: injContent.value,
                name: injName.value || 'injector',
                senderUID: injUID.value || '00000000',
                sender: injUID.value || '00000000'
            };
            const ok = tryInjectMessage(state.mmoExt, payload);
            injBtn.textContent = ok ? '成功' : '失败';
            setTimeout(() => { injBtn.textContent = '注入'; }, 800);
        });
        i3.appendChild(injContent);
        i3.appendChild(injBtn);
        inj.appendChild(i3);
        bodyEl.appendChild(inj);

        const methBlock = el('div', 'mt-block');
        methBlock.appendChild(el('div', 'h', (state.mmoExtName || 'MMO') + ' 方法'));
        methBlock.appendChild(el('div', 'sub', '点击调用（参数为 JSON 数组）'));
        buildMethodList(methBlock, ext, state.mmoExtName || 'MMO');
        bodyEl.appendChild(methBlock);
    }

    function tryInjectMessage(ext, payload) {
        try {
            const room = ext.currentRoom;
            if (!room) return false;
            const handlers = room.onMessageHandlers || {};
            const entry = handlers[payload.type];
            if (!entry) return false;

            if (Array.isArray(entry)) {
                for (const cand of entry.flat()) {
                    if (typeof cand === 'function') {
                        cand(payload);
                        return true;
                    }
                }
            } else if (typeof entry === 'function') {
                entry(payload);
                return true;
            }
            return false;
        } catch (e) {
            ERR('注入失败', e);
            return false;
        }
    }

    function renderData() {
        bodyEl.innerHTML = '';
        const scope = currentTab === 'user' ? 'user' : 'project';
        const cache = scope === 'project' ? state.projectData : state.userData;

        const qRow = el('div', 'mt-toolbar');
        const qInput = el('input');
        qInput.placeholder = '输入 key 查询';
        const qBtn = el('button', null, '查询');
        qBtn.addEventListener('click', async () => {
            const key = qInput.value.trim();
            if (!key) return;
            qBtn.disabled = true; qBtn.textContent = '...';
            await queryValue(scope, key);
            qBtn.disabled = false; qBtn.textContent = '查询';
            render();
        });
        qInput.addEventListener('keypress', e => { if (e.key === 'Enter') qBtn.click(); });
        qRow.appendChild(qInput);
        qRow.appendChild(qBtn);
        bodyEl.appendChild(qRow);

        if (!state.ccwDataExt) {
            bodyEl.appendChild(el('div', 'mt-empty', '未检测到 CCWData 扩展'));
            return;
        }
        if (cache.size === 0) {
            bodyEl.appendChild(el('div', 'mt-empty', '暂无数据，请主动查询一个 key'));
            return;
        }
        cache.forEach((value, key) => {
            bodyEl.appendChild(renderDataItem(scope, key, value));
        });
    }

    function renderDataItem(scope, key, value) {
        const item = el('div', 'mt-block');
        item.appendChild(el('div', 'h', key));
        item.appendChild(el('div', 'sub', '类型: ' + typeof value));
        const row = el('div', 'mt-row');
        const inp = el('input');
        inp.type = 'text';
        inp.value = typeof value === 'object' ? safeStringify(value) : String(value);
        const saveBtn = el('button', null, '写入');
        saveBtn.addEventListener('click', async () => {
            let v = inp.value;
            const t = typeof value;
            if (t === 'number') { const n = Number(v); if (!Number.isNaN(n)) v = n; }
            else if (t === 'boolean') v = (v === 'true');
            else if (t === 'object' && value !== null) { try { v = JSON.parse(v); } catch (e) { } }
            saveBtn.textContent = '...';
            const ok = await setValue(scope, key, v);
            saveBtn.textContent = ok ? '成功' : '失败';
            setTimeout(() => { saveBtn.textContent = '写入'; }, 800);
        });
        const reBtn = el('button', null, '重读');
        reBtn.addEventListener('click', async () => {
            reBtn.textContent = '...';
            await queryValue(scope, key);
            reBtn.textContent = '重读';
            render();
        });
        row.appendChild(inp);
        row.appendChild(saveBtn);
        row.appendChild(reBtn);
        item.appendChild(row);
        return item;
    }

    console.log('[MMO Toolbox] 已加载，Ctrl+Shift+M 打开面板');
})();
