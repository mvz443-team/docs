# Manager 与固定步长循环

> 适用代码：`src/game/managers/**`、`src/game/scenes/Game.ts`、`src/game/managers/CombatManager.ts`
>
> 相关阅读：[Model 能力边界](../models/1_model.md#model-boundary)、[Entity 能力边界](../models/2_entity.md#entity-boundary)、[回滚与同步](../models/3_rollback_and_sync.md#rollback-overview)

## 1. Manager 是什么

Manager 是**全局单例的系统服务**，负责管理一类跨实体资源或驱动一条系统流程。它不是业务逻辑的承载者：战斗决策写在 [Model](../models/1_model.md#model-role)，物理与单向渲染写在 [Entity](../models/2_entity.md#entity-role)，Manager 只提供查询、注册、调度和状态快照入口。

所有 Manager 继承 `BaseManager`：

```ts
export abstract class BaseManager {
  public abstract Load(): void;
  public abstract Reset(): void;
  public setScene(scene: Game): void { /* 保存 scene 引用 */ }
}
```

约定：

| 方法 | 调用时机 | 用途 |
| --- | --- | --- |
| `setScene(scene)` | 场景创建时 | 注入当前 `Game` 实例 |
| `Load()` | 一局游戏开始时 | 注册事件、初始化容器 |
| `Reset()` | 场景销毁 / 重开时 | 清空监听器和状态 |

`Game.ts` 里的 `ManagerGroup` 决定初始化与销毁顺序：

```text
CombatManager → CardpileManager → CursorManager → DeferredManager
→ GridManager → KeybindManager → MobManager → ObstacleManager
→ TileItemManager → PlantsManager → ResourceManager → SoundManager
→ PresetEventManager → SyncManager → TickerManager
→ DebugManager → PositionManager
```

`SoundManager` 会在 preload 阶段提前初始化，其余 Manager 由 `Game.create()` 统一 `setScene()` + `Load()`。

对局拆除走 `Game.teardownSession()`（幂等）：先卸载全局引用与 UI/输入/声音，再调用 `ProjectileCmd.clearProjectiles(this)` 清投射物模块级注册表，最后只对仍绑定本场景的 Manager 调 `Reset()` 并清空 `ManagerGroup`。新增模块级序号/注册表时必须同步接入这条路径，否则连续开第二局会首帧分叉。详见 [跨局清理](../models/3_rollback_and_sync.md#cross-session-cleanup)。

## 2. 核心 Manager 速查

| Manager | 主要职责 | 重要入口 / 状态 |
| --- | --- | --- |
| `CombatManager` | 固定步长主循环、暂停、快照、哈希自检 | `update()`、`captureState()`、`restoreState()`、`rollbackToFrame()` |
| `SyncManager` | 网络输入队列、种植预览、权威确认 | `recvQueue`、`sendQueue`、`update()` |
| `DeferredManager` | 延迟执行命令队列 | `defer()`、`flush()`、`Reset()` |
| `GridManager` | 网格类型与行属性统计 | `setGridProperty()`、`RowPropertyRatio()` |
| `PositionManager` | 格子坐标、缩放、世界边界 | `getPlantBottomCenter()`、`getZombieBottomCenter()` |
| `MobManager` | 出怪波次、怪物容器、击杀计数 | `MobsByLane`、`startFirstWave()`、`CapturePrngState()` |
| `PlantsManager` | 植物容器、种植/铲除、视线反射体 | `PlantsMap`、`PlantsByLane`、`RegisterPlant()` |
| `ObstacleManager` | 障碍物按格与按行索引 | `ObstaclesMap`、`RegisterObstacle()` |
| `ResourceManager` | 能量与星碎 | `UpdateEnergy()`、`UpdateStarShards()` |
| `CardpileManager` | 卡牌选择、冷却 | `stepUpdate()`、`CaptureCardpileState()` |
| `PresetEventManager` | 关卡脚本触发的事件、昼夜、章节预设 | `onNewWave()`、`Chapter1Dispatch()` |
| `TickerManager` | 全局帧定时器（系统级，不是实体技能定时器） | `delayedCall()`、`addEvent()`、`GetTimerStates()` |
| `TileItemManager` | 场上可拾取物 | 快照 / 恢复接口 |

## 3. 固定步长主循环

`CombatManager.update()` 是确定性模拟的唯一入口。一个逻辑帧的顺序如下：

```text
1. DeferredManager.flush()               // 执行上一帧延迟入队的创建/销毁/伤害
2. SyncManager.update()                  // 消费权威输入，确认本帧是否可以推进
3. logicEvents.setFrame(frameId)         // 一次性表现事件绑定逻辑帧
4. TickerManager.Update()                // 全局系统定时器
   updateAllTickManagers(...)            // 驱动每个 Model 的独立定时器
   CardpileManager.stepUpdate()
5. rapierWorld.step()                    // 物理推进
6. drainCollisionEvents()                // 碰撞事件广播给 Entity
7. BaseEntity.stepUpdate()/updateView()  // Model 每帧逻辑 + 视图同步
8. 哈希采样 / 环形快照 / 确定性自检
9. stepMove(alpha)                       // 渲染插值
10. sendQueue.Consume()                  // 发送本地输入
```

关键参数：

- `MAX_FRAME_DELTA_MS = 250`：单帧最大 delta，防止后台切回时一次追太多。
- `MAX_ELAPSED_FRAME_TIME_MS = 1000`：累计时间上限。
- `MAX_STEPS_PER_UPDATE = 4`：单个渲染帧最多推进 4 个逻辑步。

不要在 Manager 或 Entity 里自己启动另一套 `setInterval` / `scene.time.addEvent` 驱动游戏逻辑。表现动画可以用 Tween，但会影响战斗结果的状态必须由固定步长循环推进。

## 4. DeferredManager 使用边界

`DeferredManager` 用来避免在物理世界借用期修改世界，也保证快照落在干净帧边界。

必须 defer 的操作：

- 创建 / 销毁实体。
- 造成伤害、改血量、改睡眠状态。
- 生成 / 移除障碍物、投射物、掉落物。

通常不需要 defer 的操作：

- 播放音效。
- 创建一次性粒子 / Sfx 对象。
- 修改纯视图属性（Sprite 位置、透明度、动画）。

`flush()` 会先浅拷贝队列再清空，因此任务内部再次 `defer()` 不会造成死循环；单个任务抛错会被捕获并记录。

## 5. Manager 与状态快照

参与回滚的 Manager 通过 `RuntimeStateBridge.installRuntimeStateSources()` 注册状态源：

```text
seed/frame → combat 值 → resources → cardpile → wave/waves
→ tileitem → grid → logic.events → ticker timers → PRNG
→ entities(mob/plant/obstacle/projectile) → physics
```

详见 [回滚与同步](../models/3_rollback_and_sync.md#rollback-state-layout)。新增 Manager 状态时，如果只是表现状态，不要进快照；如果会影响战斗结果，必须提供 `capture/restore`，并且字段必须是 JSON 安全的。

## 6. 新增 Manager 的清单

1. 继承 `BaseManager`，实现 `Load()` 与 `Reset()`。
2. 提供 `static get Instance()`，不要在构造器里外部注入业务对象。
3. 在 `Game.ts` 的 `ManagerGroup` 中按依赖顺序注册。
4. 若持有确定性状态，实现 `Capture*State()` / `Restore*State()` 并在 `RuntimeStateBridge` 注册。
5. 实体级逻辑不要写进 Manager；放到对应 [Model](../models/1_model.md#model-role)。
6. 所有会修改模拟状态的公共入口优先通过 [Cmd](./2_cmd.md#cmd-overview) 调用，以便统一 defer。
