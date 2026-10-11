# MMO Toolbox

一个运行在 CCW（共创世界）作品页面上的用户脚本，用于查看和调试作品的 MMO 消息流与云数据。

## 背景

在 CCW 上开发带联机功能的作品时，调试手段很有限。MMO 消息走的是扩展内部封装，作品发出去什么、收到什么、消息结构长什么样，在创作者面板里完全看不到。云数据（CCWData）同样如此，key 和值只能靠作品自己的 UI 间接观察。

这个脚本在运行时把 MMO 和 CCWData 的关键接口挂上钩子，把消息流和数据访问暴露出来，并允许在调试过程中进行拦截、替换和注入。它面向的是作品作者本人，用于排查联机逻辑的问题。

## 功能

**消息面板**
- 记录所有 incoming 和 outgoing 的 MMO 消息，含类型、发送者、UID、内容、时间戳
- 按类型或内容关键词过滤
- 导出为 JSON，便于离线比对编码格式

**拦截规则**
- 按 type 精确匹配、按 content 正则匹配
- 命中的消息可以丢弃（不让作品收到）或替换内容（改写后再交给作品）
- 规则存入 localStorage，刷新不丢

**房间面板**
- 实时显示 currentRoom 的全部字段
- 展开 players 列表，查看每个玩家对象的属性
- 记录玩家进入/离开的变化历史
- 简单字段支持直接编辑（本地生效，可能被服务器覆盖）

**广播面板**
- 手动发送 MMO 广播，指定 type 和 content
- 常用消息可存为模板，一键重发
- 注入 incoming 消息：构造一条假消息直接触发作品的处理器，模拟其他玩家发来的数据，用于测试接收端逻辑
- 列出 MMO 扩展的全部方法，可手动调用并查看返回值

**数据面板**
- 查看通过 CCWData 读写的作品数据和用户数据
- 主动查询任意 key
- 编辑并写回服务端

**状态面板**
- 显示 VM 捕获状态和捕获路径
- 列出所有已加载的扩展及其方法

## 安装

需要先安装用户脚本管理器。

- Violentmonkey（推荐）
- Tampermonkey

安装管理器后，新建脚本，把 `mmo-toolbox.user.js` 的内容粘进去保存即可。

加载时机必须是 `document-start`，脚本依赖这个时机在 VM 创建时挂上钩子。Tampermonkey 在某些配置下会隔离 `Function.prototype`，导致 VM 捕获失败。如果遇到这种情况，改用 Violentmonkey，或在设置中开启 page 模式同步注入。

## 使用

打开任意 CCW 作品页面，脚本会自动注入。右上角出现圆形按钮，点击展开面板，或按 `Ctrl + Shift + M` 切换。

面板顶部是状态栏，显示 VM 捕获状态、已捕获扩展数、消息条数等。

## 技术原理

脚本做三件事。

**捕获 VM 实例。** 在 `document-start` 阶段包装 `Function.prototype.bind`，当 VVM 实例绑定自身方法时截获它。VVM 实例的特征是同时拥有 `editingTarget` 和 `runtime` 两个自有属性。这一步是后续所有 hook 的前提。如果 bind trap 被沙箱隔离，脚本会退回到扫描 `window` 全局对象和 React DOM 内部属性来查找 VM。

**挂载扩展注册钩子。** VM 捕获后，包装 `vm.runtime.compilerRegisterExtension`。Gandi 内部所有扩展（无论官方还是自定义）注册时都会经过这个方法，通过它拿到 CCWData 和 CCWMMO 的实例对象。

**包装关键方法。**
- CCWData 的 `_getValueFromProject`、`_setValueToProject`、`_getValueFromUser`、`_setValueToUser`，用于记录和改写数据访问。
- MMO 的 `dispatchNewMessageWithParams`，这是所有 incoming 消息进入 Scratch 线程的必经之路。在这个位置记录消息、应用拦截规则、或者在丢弃时直接返回 false 阻断传递。
- MMO 的 `broadcastMsg`、`sendMsg` 等 outgoing 方法，用于记录发送记录。

注入功能不经过网络，直接在本地调用作品的 `onMessageHandlers` 中对应 type 的回调，模拟消息到达。这不会向服务器发送任何数据。

## 已知限制

**服务器权威。** MMO 的 currentRoom 数据由服务器同步。本地修改 `players` 里的字段会在下一帧被服务器推送覆盖。编辑功能用于观察"如果这个值是 X 会怎样"，不是持久化修改。

**注入依赖回调结构。** `tryInjectMessage` 假设 `onMessageHandlers[type]` 是数组或函数。如果作品使用别的消息分发结构，注入会失败。这类情况需要针对具体作品适配。

**outgoing 方法名列表有限。** 目前只包装了常见的方法名。如果作品使用别的命名，发送记录里看不到。可以在状态面板展开 MMO 扩展，看完整方法列表。

**扩展私有字段名依赖版本。** 查找扩展实例时尝试了多个候选字段名（`_loadedExtensions`、`loadedExtensions` 等）。如果 CCW 更新了内部实现，这一步可能需要同步修改。

## 兼容性

在 CCW 主站和 Gandi 运行时的作品页面上测试通过。浏览器要求支持 ES2020（现代 Chrome、Edge、Firefox 均可）。

## 开发

代码是单文件用户脚本，没有构建步骤。修改后直接在用户脚本管理器中更新，刷新作品页面即可生效。

维护时注意几个外部依赖点。CCW 更新 MMO 或 CCWData 的实现时，方法名或内部结构可能变化，需要同步检查脚本中的以下位置：

- `isVM` 的 VVM 特征判定
- `registerExt` 中识别 CCWData / MMO 扩展的条件
- `hookMMO` 中 `dispatchNewMessageWithParams` 的参数结构
- `tryInjectMessage` 对 `onMessageHandlers` 结构的假设

## 协议

MIT

## 致谢

VM 捕获思路参考自 [CSense](https://github.com/csense-rev/csense-rev)，一个 CCW 平台的安全审计工具。本项目在其基础上专注于 MMO 和云数据的调试场景。
