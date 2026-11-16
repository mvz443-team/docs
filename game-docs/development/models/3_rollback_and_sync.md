# 回滚与联机同步

<a id="rollback-overview"></a>

> 适用代码：`src/game/core/SimulationState.ts`、`RuntimeStateBridge.ts`、`EntitySnapshot.ts`、`PhysicsSnapshot.ts`、`EntityLookup.ts`、`CombatManager.ts`
>
> 相关阅读：[Model 快照职责](./1_model.md#model-rollback)、[Entity 快照职责](./2_entity.md#entity-rollback)、[Manager 状态源](../kit/1_manager.md#5-manager-与状态快照)

## 1. 设计目标

回滚不是“重画画面”，而是把确定性模拟恢复到某一逻辑帧。满足三个条件才安全：

1. 所有会影响战斗结果的状态都能被捕获和恢复。
2. 恢复后继续推进的结果与从未回滚过一致。
3. 一次性表现事件不会因重演而重复播放。

因此系统把状态分为三类：

| 类型 | 例子 | 是否进快照 |
| --- | --- | --- |
| 确定性逻辑状态 | 血量、冷却、技能阶段、timer、PRNG、资源 | 是 |
| 关系与身份 | attacking、underAttackBy、summoner、稳定 id | 是 |
| 表现状态 | Sprite、Tween、音效、粒子 | 否 |

<a id="rollback-state-layout"></a>

## 2. 全量状态结构

`SimulationState` 定义：

```ts
interface SimulationState {
  version: number;
  seed: number;
  frameId: number;
  values: Record<string, JsonValue>;
  timers: Record<string, TimerState[]>;
  prngs: PrngState[];
  entities: EntityLogicState[];
  physics: string | null;
}
```

`RuntimeStateBridge.installRuntimeStateSources()` 注册来源：

```text
seed / frame
combat.dayOrNight / isGameEnd / isPaused
ticker.currentFrame / nextTimerId / frameInterval
resources / cardpile / wave / waves / mob.spawn
tileitem / grid / logic.events
ticker timers / mob.alea PRNG
entities: mob / plant / obstacle / projectile
physics snapshot
```

新增会影响战斗结果的系统时，必须注册对应状态源；纯表现数据不要注册。

<a id="rollback-model"></a>

## 3. Model 的恢复职责

Model 的运行时字段由 `LogicState` Proxy 自动记录：

- 写入字段、删除字段、数组 mutate 都会进入 Undo Log。
- `snapshot()` 只导出 JSON 安全字段。
- `rollbackTo(frame)` 逆序撤销目标帧之后的修改。

全量恢复时，`BaseEntity.restoreSnapshot()` 调用 `restoreModel(model, state.flags.model)`，把字段写回 Model。

Model 还要负责恢复自己的计时器：

```ts
timers: this.model?.captureTimers() ?? [],
...
this.model?.restoreTimers(state.timers ?? [], context);
```

`EntityTickManager.restore()` 会：

1. 删除快照之后新增的 timer。
2. 回写已有 timer 的 `targetFrame/repeat/interval/eventName/args`。
3. 对重建实体缺失的 timer，按 `kind + args` 直接重建纯数据。
4. 恢复 `nextTimerId`，保证后续 timer id 与连续运行一致。

回调本身不恢复：函数注册表按函数身份稳定存在，因此不会创建新闭包，也不会恢复出幽灵回调。

<a id="rollback-entity"></a>

## 4. Entity 的恢复职责

Entity 保存胶水层状态：

- `SnapshotId`：稳定实体身份。
- `col/row/x/y`。
- `hp/maxHp/speed` 的兼容字段。
- `flags`：关系字段、PRNG、子类 `captureLogicState()`、Model 快照。
- `extra.rigidBodyHandle`：刚体句柄。

恢复顺序：

```text
restoreRelations
restorePrngs
restoreLogicState
restoreTimers
restoreModel
hp / maxHp / speed
applySnapshotPosition
syncViewFromModel
```

`syncViewFromModel()` 是回滚后恢复表现的统一入口。装备 mixin 在这里按 `helmetHealth / shieldHealth / weaponVisible / weaponSwinging` 恢复 sprite 可见性、frame 和挥动 Tween，不要依赖旧 Tween 是否还在。

位置恢复优先使用物理 translation，并把视图子对象整体平移差值，避免重建每个 Sprite。

关系字段用 `entity:<SnapshotId>` 编码，恢复时通过 `EntityLookup` 解析。找不到目标时写入 `report.missing`，不会静默保留旧引用。

<a id="rollback-timers"></a>

## 5. 两类 timer

### 全局 TickerManager

用于 Manager 级系统流程，例如出怪波次、卡牌系统。

- `GetTimerStates()` 导出 `TimerState[]`。
- `RestoreTimerStates(states, context)` 支持 in-place 和 rebuild。
- rebuild 需要 `snapshot.kind` 与已注册的 `timerFactory`。

### Model 的 EntityTickManager

用于实体技能与战斗时序。

- 每个 Model 一个实例。
- timer 只存纯数据。
- 到点派发 `TickEventNameEnums` 给 `LogicModel.handleTickEvent()`。
- 不依赖全局工厂，重建实体后也能按 `kind + args` 恢复。

规则：实体技能不得使用 `scene.time.delayedCall()`；全局 TickerManager 不用于实体技能。

<a id="rollback-modes"></a>

## 6. in-place 与 rebuild

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `in-place` | 在原对象上回写；删除快照后新增的实体/计时器 | 正常回滚重演 |
| `rebuild` | 清空并重建实体/计时器 | 断线重连、跨会话恢复 |

`CombatManager.rollbackToFrame()` 使用 in-place；`restoreState(state, mode)` 可指定 rebuild。

实体对账：

- `mob/plant`：删除快照外实体；缺失时按 `mid/pid/waveID/level` 重建，并复用稳定 key。
- `obstacle/projectile`：缺失时只能按 `rebuildFactories` 或报告 missing。
- 稳定 key 示例：`mob:${waveId}:${spawnSeq}`、`plant:${col}:${row}:${pid}`。

`PhysicsSnapshot` 在 rebuild 中负责 world 恢复和 `userData` 重绑。

<a id="sync-loop"></a>

## 7. 联机同步与帧推进

`SyncManager` 管理输入队列：

```text
本地输入 → sendQueue → 服务端
服务端权威输入 → recvQueue → CombatManager.update()
```

`SyncManager.update()` 每逻辑帧调用，未就绪时补空帧，保证两端按同一帧号推进。

一次性表现事件走 `LogicEventQueue`：

```ts
{ frame, eventId, type, sourceId, data }
```

Entity 用 `consumeLogicEvents()` 按 `eventId` 去重消费；回滚时队列会撤销目标帧之后的事件并恢复 `nextEventId`。

确定性自检：

- `CombatManager` 每 10 帧采样一次状态哈希，环形快照大小 20。
- 回滚后会重放并记录哈希，验证恢复结果。
- `hashSimulationState()` 用 FNV-1a，并按 IEEE-754 位模式写数值，避免 NaN / -0 / 键顺序差异。

## 8. 开发检查清单

新增逻辑时问自己：

1. 这个状态会影响战斗结果吗？是则必须在 Model 或注册状态源中。
2. 字段是 JSON 安全的吗？否则改为 ID / 枚举 / 数字。
3. 延迟逻辑用的是 Model timer 吗？否则改用 `tickmanager.schedule()`。
4. 实体引用是否在 `LogicRelations.ts` 中声明？否则回滚后无法解析。
5. 随机数是否来自播种的 PRNG / `MobCmd.DeterministicRandom()`？
6. 表现事件是否通过 `logicEvents.emit()`，而不是直接播音效？
7. 重建实体时能否得到相同的 `SnapshotId` 和初始配置？
