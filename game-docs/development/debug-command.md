# 浏览器 Console 调试指令（DBG）

> 适用代码：`src/game/utils/ConsoleCmd.ts`
>
> 相关代码：`src/game/scenes/Game.ts`、`src/game/managers/combat/CardpileManager.ts`、`src/game/managers/combat/ResourceManager.ts`、`src/game/managers/view/DebugManager.ts`

游戏进入战斗场景后，会把调试命令对象挂到浏览器全局变量 `window.DBG` 上，直接在开发者工具 Console 里调用即可。它主要用于本地单机调试，不是正式游戏接口。

## 1. 调用方式

1. 启动游戏并进入一局战斗（`Game` 场景创建完成）。
2. 打开浏览器开发者工具，切换到 Console。
3. 输入 `DBG.help()` 查看当前可用命令。
4. 直接调用命令，例如：

```js
DBG.help()
DBG.spawnMonster(1)
DBG.addResource("energy", 100)
DBG.cards()
```

`Game` 场景创建时会自动执行 `ConsoleCmd.install(this)`：

- 设置 `window.DBG`；
- 在 Console 打印 `DBG Ready / Local single-player only` 横幅和命令帮助。

游戏结束流程 `handleRoomGameEnd()` 会执行 `ConsoleCmd.uninstall(this)` 并删除 `window.DBG`。因此：

- 没进战斗场景时 `DBG` 是 `undefined`；
- 退出本局后 `DBG` 会被移除，下一局进入战斗场景时重新挂载。

### 1.1 可用范围

会修改游戏状态的命令（`spawnMonster`、`addResource`、`reloadCard`、`cooldownCard`、`cards`）都经过 `ensureLocalSinglePlayer()` 检查：

- 玩家人数必须不超过 1；
- 且当前不是真实联机模式。

当前实现允许“本地单机”和“mock 房间的单人模式”。真实联机或多人房间中调用会打印警告并返回 `null`：

```text
DBG is only available in local single-player games. current mode=online, players=2
```

`DBG.help()` 不受此限制，任何模式下都可以打印帮助。

### 1.2 与“显示调试信息”设置的关系

设置里的“显示调试信息”（`isDebug`）控制的是另一套可视化调试：

- 显示 `frameId / ackFrameId`；
- 显示“按 D 切换 Rapier 调试”的提示；
- 按 `D` 切换 Rapier 碰撞体线框。

它**不控制** `DBG`。`ConsoleCmd.install()` 是无条件调用的，所以即使没有开启“显示调试信息”，Console 里的 `DBG` 仍然存在。

## 2. 命令速查

| 命令 | 参数 | 作用 | 成功时返回 |
| --- | --- | --- | --- |
| `DBG.help()` | 无 | 打印命令帮助 | `void` |
| `DBG.spawnMonster(mid, row?, col?, carryStarShards?)` | 怪物 mid、行、列、是否携带星之碎片 | 在指定格生成一只怪物 | `MonsterEntity` |
| `DBG.spawn(...)` | 同上 | `spawnMonster` 的别名 | `MonsterEntity` |
| `DBG.addResource(kind, amount)` | 资源类型、增量 | 给所有玩家增加/减少资源 | 当前玩家该资源的数值 |
| `DBG.add(...)` | 同上 | `addResource` 的别名 | 当前玩家该资源的数值 |
| `DBG.reloadCard(slot)` | 卡槽序号，从 0 开始 | 把该卡槽冷却重置为**完整冷却** | 更新后的 `CardInfo` |
| `DBG.cooldownCard(slot)` | 卡槽序号，从 0 开始 | 把该卡槽冷却清零，**立即就绪** | 更新后的 `CardInfo` |
| `DBG.cards()` | 无 | 打印并返回所有卡槽状态 | `CardInfo[]` |
| `DBG.cardInfo()` | 无 | `cards` 的别名 | `CardInfo[]` |

被拦截、参数非法或目标不存在时，命令会 `console.warn` 并返回 `null`。

## 3. 命令详解

### 3.1 `DBG.spawnMonster(mid, row = 0, col = MaxCol + 1, carryStarShards = false)`

在指定位置直接生成一只怪物。

| 参数 | 含义 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mid` | 怪物模型 id | 必填 | 必须已在 `MonsterLibrary` 注册 |
| `row` | 行索引，从 0 开始 | `0` | 会被限制在 `0 ~ Row_Number - 1` |
| `col` | 列索引，从 0 开始 | `Col_Number + 1` | 当前战斗网格为 9 列，因此默认是 `10`，即右侧场外 |
| `carryStarShards` | 是否携带星之碎片 | `false` | 为 `true` 时调用 `entity.addStarShards()`，携带 1 个碎片 |

示例：

```js
// 在第 0 行、默认场外列生成普通僵尸
DBG.spawnMonster(1)

// 在第 2 行、第 8 列生成黑曜石傀儡，并让它携带星之碎片
DBG.spawnMonster(12, 2, 8, true)

// 别名写法
DBG.spawn(10, 1, 10)
```

返回值：

- 成功：返回创建出来的 `MonsterEntity`，可以在 Console 里继续查看字段；
- `mid` 不存在：打印 `Monster mid=... does not exist.`，返回 `null`；
- 非本地单人：打印范围限制警告，返回 `null`。

当前注册的怪物 mid：

| mid | preset `nameKey` | mid | preset `nameKey` |
| --- | --- | --- | --- |
| 1 | `Zombie` | 10 | `Vindicator` |
| 2 | `CapZombie` | 11 | `VindicatorSolider` |
| 3 | `HelmetZombie` | 12 | `ObsidianGolem` |
| 4 | `MinerZombie` | 13 | `Warden` |
| 5 | `MinerHelmetZombie` | 14 | `TurtleZombie` |
| 6 | `Skeleton` | 15 | `Mutant` |
| 7 | `SkeletonBow` | 16 | `TurtleSkeletonBow` |
| 8 | `StickZombie` | 17 | `Centipede` |
| 9 | `Evoker` | 18 | `CentipedeMinion` |

注意事项：

- 只有 `mid = 17 / 18`（蜈蚣及其小怪）的 `couldCarryStarShards` 为 `false`。对它们传入 `carryStarShards = true` 时，怪物仍会生成，但不会携带星之碎片，并会打印警告。
- 调试生成的怪物使用 `waveID = -9999`，不会计入波次击杀数，也不会触发波次击杀统计。
- 该命令为了调试方便，直接调用 `model.createEntity()` 并注册到 `MobManager`，**没有走 `MobCmd` 的 defer 队列，也没有分配稳定快照 key**。因此它只适合本地调试，不能作为正式生成流程的参考。
- `col` 不做 clamp；`row` 才会 clamp。

### 3.2 `DBG.addResource(kind, amount)`

修改所有玩家的资源。当前命令限制本地单人，所以实际上只会影响本地玩家。

`kind` 支持以下写法（大小写不敏感、会 trim）：

| 资源 | 可用值 |
| --- | --- |
| 能量 | `"energy"`、`"能量"` |
| 星之碎片 | `"starshards"`、`"starshard"`、`"star"`、`"stars"`、`"星之碎片"`、`"星碎"` |

`amount` 是**增量**，不是设置成某个值：

- 能量没有上限，可以为负数；
- 星之碎片会被限制在 `0 ~ 10`；
- `amount` 不是有限数字时打印 `Invalid amount` 并返回 `null`。

示例：

```js
DBG.addResource("energy", 500)      // 能量 +500
DBG.addResource("能量", -50)         // 能量 -50
DBG.addResource("starshards", 3)    // 星之碎片 +3，最多到 10
DBG.add("星碎", -2)                  // 星之碎片 -2，最少到 0
```

返回值是命令执行后当前玩家的能量或星之碎片数量。

注意：该命令直接调用 `ResourceManager.UpdateEnergy / UpdateStarShards`，没有走 `ResourceCmd`，只用于本地调试。

### 3.3 `DBG.cards()` / `DBG.cardInfo()`

读取 `CardpileManager.cardpileStatus`，用 `console.table` 打印所有卡槽，并返回数组。

返回的每个 `CardInfo` 包含：

| 字段 | 含义 |
| --- | --- |
| `slot` | 卡槽序号，从 0 开始；本质是 `cardpileStatus` 的迭代顺序 |
| `pid` | 植物模型 id |
| `level` | 卡牌等级 |
| `leftMs` | 正式剩余冷却，毫秒 |
| `leftFrame` | 正式剩余冷却，换算为同步帧 |
| `previewLeftMs` | 表现层预演剩余冷却，毫秒 |
| `previewLeftFrame` | 预演剩余冷却，换算为同步帧 |
| `displayLeftMs` | 实际展示冷却，`max(leftMs, previewLeftMs)` |
| `displayLeftFrame` | 实际展示冷却，换算为同步帧 |
| `totalMs` | 总冷却，毫秒 |
| `totalFrame` | 总冷却，换算为同步帧 |
| `hasReloaded` | `displayLeftMs <= 0` 时为 `true`，表示卡牌已就绪 |

帧换算规则：`Math.ceil(ms / frameIntervalMs)`，当前 `frameIntervalMs = 50`，即 1 帧 = 50ms。

示例输出字段：

```js
DBG.cards()
// [{ slot: 0, pid: 1, level: 1, leftMs: 0, leftFrame: 0, ... hasReloaded: true }]
```

### 3.4 `DBG.reloadCard(slot)`

让指定卡槽进入**完整冷却**：`leftMs = totalMs`、`previewLeftMs = 0`。

虽然命令名叫 `reloadCard`，实际效果是“重新装填/开始冷却”，调用后卡牌会变灰，直到冷却走完。

```js
DBG.reloadCard(0) // 第 0 个卡槽开始完整冷却
```

`slot` 是 `DBG.cards()` 返回的 `slot`，不是 `pid`。

### 3.5 `DBG.cooldownCard(slot)`

让指定卡槽**立即就绪**：`leftMs = 0`、`previewLeftMs = 0`。

这个命令名同样容易误解：它不是“开始冷却”，而是“清除冷却”。

```js
DBG.cooldownCard(0) // 第 0 个卡槽立即可以再次使用
```

注意：`DBG.help()` 目前没有列出 `cooldownCard`，但命令对象上确实存在。

## 4. 返回值与输出约定

| 情况 | 表现 |
| --- | --- |
| 成功 | `console.log` 打印带 `DBG` 徽标的绿色消息 |
| 被拦截 / 参数错误 / 目标不存在 | `console.warn` 打印橙色消息，并返回 `null` |
| `spawnMonster` 成功 | 返回 `MonsterEntity` |
| `addResource` 成功 | 返回当前玩家的资源数值 |
| `reloadCard` / `cooldownCard` 成功 | 返回更新后的 `CardInfo` |
| `cards` 成功 | 返回 `CardInfo[]`，同时打印表格 |

## 5. 常见用法

```js
// 查看帮助
DBG.help()

// 生成一只普通僵尸
DBG.spawnMonster(1)

// 生成一只带星之碎片的黑曜石傀儡
DBG.spawnMonster(12, 2, 8, true)

// 补 1000 能量
DBG.addResource("energy", 1000)

// 看卡槽冷却
DBG.cards()

// 让 0 号卡槽进入完整冷却 / 立即就绪
DBG.reloadCard(0)
DBG.cooldownCard(0)
```

## 6. 调试命令的边界

- 只用于本地单机调试；真实联机会被拦截。
- 命令直接操作 Manager / Entity，不保证进入回滚快照，也不遵循正式的 `Cmd` defer 流程。
- 调试生成物、资源修改和卡槽修改都可能造成本地状态与正常对局流程不一致；不要据此判断正式战斗数值或同步行为。
- 新增怪物 preset 后，记得同步更新上面的 mid 表；mid 的注册入口是 `MonsterLibrary.Initialize()`。
