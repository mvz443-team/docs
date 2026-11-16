# 回滚与联机同步

<a id="rollback-overview"></a>

> 适用代码：`src/game/core/SimulationState.ts`、`RuntimeStateBridge.ts`、`EntitySnapshot.ts`、`PhysicsSnapshot.ts`、`EntityLookup.ts`、`CombatManager.ts`
>
> 相关阅读：[Model 快照职责](./1_model.md#model-rollback)、[Entity 快照职责](./2_entity.md#entity-rollback)、[Manager 状态源](../kit/1_manager.md#5-manager-与状态快照)

> 2026-11-16 复查补充：本文区分三件事——**服务端权威帧同步**、**客户端确定性模拟**、**客户端本地回滚/恢复**。服务端不保存、不比较完整战局状态，也不下发状态快照；所谓“回滚恢复”均发生在客户端进程内，服务端只提供输入帧、ACK 补发、开局配置、状态摘要告警和重连后的帧续传。

> 2026-11-16 更新：已按“预测式帧同步 + 可恢复回滚”的目标调整实现：
> 1. 分叉不再只报不修；客户端进入不可恢复的离线单机模式，恢复暂停/倍速与正常收益，并在结算时下载一次 Desync 日志。
> 2. 新增每 200 帧一次的低频 checkpoint；只在双端摘要一致时由服务端采纳，重连后从 checkpoint 之后回放权威操作。
> 3. 高频 10 帧采样只上报轻量摘要，checkpoint 的 inline 快照不含 Rapier physics，超过 6KB 自动退化为纯 hash。
> 4. 新增左上角网络状态 HUD：`offline` / `retry(n)` / `desync` / 延迟 ms。
> 5. 回滚确定性缺口（timer ID、事件游标、恢复报告、ACK 语义）已修复并纳入测试。
> 6. 权威模式已从“只放虚影”改为“本地预测 + 权威确认/拒绝回滚”；高频状态采样不再序列化 Rapier physics。

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

<a id="client-server-authority"></a>

## 8. 服务端与客户端的实际职责边界

当前服务端是 Go + Fiber + WebSocket + Protobuf 的权威房间服务，但**不是战斗世界服务器**。

### 8.1 服务端职责

- 维护房间生命周期：`InLobby → Preparing → Loading → InGame → PostGame`。
- 保存房主选择的 `chapterId/stageId`、房间 `seed` 和双方规范化后的 `loadout`。
- 以 `FrameIntervalMs`（默认 50ms）推进服务端逻辑帧；调试时可由 `MVZ_DEBUG_FRAME_MS` 压缩到 1~50ms。
- 接收玩家操作和心跳，把操作调度到 `[current+CommandLeadFrames, current+MaxDelayFrames]`，当前为 `current+4 ~ current+10`。
- 对种植、铲除、星屑做轻量校验：格子范围、同帧同格冲突、成本上下界、自报资源非负。
- 按固定规则排序同一帧操作并编号，写入 `frameHistory`。
- 根据每个玩家的 `ackFrameId` 补发历史帧；全部 ACK 或超过 600 帧后裁剪历史。
- 比较两端上报的 32 位状态摘要，只记录“分叉已发生”，不修复分叉。
- 收集 `EndGame` 投票，把统一结果写入权威结束帧，并广播带 `endFrameId` 的 `GameEnd`。

服务端不模拟怪物/植物/投射物，不保存实体血量、位置、Rapier world，也不向客户端发送状态快照。`InGameResponse` 只携带帧号和该帧操作。

### 8.2 客户端职责

- 通过 `BackendWS` 建立 WSS；进入房间后同一连接复用所有阶段。
- 每 20FPS 固定步推进，但只有 `QueueReceive` 消费到服务端下一帧后才真正执行本帧。
- 本地根据服务端下的 `seed`、`stageId`、规范化 `loadout` 和权威操作序列运行确定性战斗模拟。
- 本地操作先进入 `QueueSend`，不会立刻改变权威世界；种植有仅表现层的半透明虚影，服务端确认或拒绝后移除。
- 心跳、ACK、资源/状态摘要通过 `RequestBlank` 上报；操作通过 `RequestCardPlant/RequestRemovePlant/RequestStarShards` 上报。
- 服务端帧缺失时暂停固定步，显示等待文本并发送 `ensureBlankFrame()`；历史帧缺口不可补时服务端单播 `RoomClosed` 要求重新加入。

### 8.3 一条操作穿过系统的顺序

```text
玩家点击
  → PlantsManager.onDeterminePlant
  → QueueSend.sendCardPlant（client_op_seq、process_frame_id、资源快照）
  → BackendWS.send → 服务端 handlePlayerMessage
  → HandleRequestCardPlant（acceptInGameBase + 校验 + resolveProcessFrameID）
  → GameLogic.PlantCard / rejectOperation
  → recordOperationSubmission(targetFrame)
  → runGameTick.advanceOneFrame（排序、编号、写 frameHistory）
  → syncClientFrames（按 ACK 补发）
  → QueueReceive.handleInGameResponse / Consume
  → SyncManager.handleRecvCardPlant
  → 本地 Model 世界执行种植并进入快照/hash 采样
```

服务端排序键依次为：`process_frame_id`、操作类型优先级（铲除→星屑→种植→游戏事件→错误）、`uid`、稳定操作签名。客户端 `QueueReceive` 再次按同语义排序后再执行。

<a id="handshake-and-frames"></a>

## 9. 开局一致性与帧同步细节

### 9.1 开局配置摘要

`RequestReady` 携带 `LoadoutSnapshot`。服务端 `canonicalPlayerLoadouts()` 对卡牌按 `pid` 去重排序、对 modifier 按 key 去重排序，并用 FNV-1a 32 位生成 `hash`。客户端 `handlers.ts` 在 `AllReady` 中用自己的 `computeLoadoutHash()` 检查自身配置；摘要不一致时发出 `RoomError` 并阻止开局，避免双方从不一致初始状态进入 lockstep。

`AllReady` 同时下发同一 `seed` 和排序后的 `playerIds`。`CombatManager` 在 `RoomAllReady` 事件中保存 `seed`，作为确定性随机源。

### 9.2 帧号与 ACK

- `QueueReceive.currentFrameId`：本地已经消费到的权威帧。
- `QueueReceive.lastAckFrameId`：本地已经确认消费的权威帧，也是服务端补发起点。
- `bufferedResponses`：已收到但尚未轮到消费的帧，上限 64。
- `replayLog`：已消费帧的回放副本，上限 300，供回滚后原地重放。
- `RequestBlank.frameId`：客户端心跳帧号，语义是“客户端当前位置”，不是哈希对应帧。
- `RequestBlank.ackFrameId`：客户端已消费帧，服务端据此推进补发/裁剪。
- `RequestBlank.hashFrameId`：状态摘要对应的逻辑帧。

客户端固定步未拿到下一帧时，`SyncManager.update()` 返回 false，`CombatManager.update()` 不扣除 `elapsedFrameTime`、不推进物理/timer、不采样 hash，并通过 `ensureBlankFrame()` 提醒服务端补发。线上暂停和倍速被禁用；单机 mock 复用同一管线但不具备真实多端校验意义。

### 9.3 历史帧缺口与重连

`syncClientFrames()` 只从 `max(lastAck+1, LastSynced+1)` 开始补发；若该起点早于最早历史帧且中间确有缺口，服务端调用 `notifyResyncGap()` 单播 `RoomClosed`，客户端按“重新加入房间”处理，而不是跳过缺失帧。

InGame 掉线时服务端保留玩家席位并标记 `PlayerStateDisconnected`，连接代数递增以确保旧读循环不会误注销新连接。客户端 `BackendWS` 保持本地战局，按 300ms 起的指数退避最多尝试 12 次重连；重连地址带 `id/key/reconnect=1/my_id`。重连成功后服务端不回 `JoinRoomSuccess`，客户端立即用当前帧/ACK 发一个 blank，触发断点补帧。超过历史窗口或超时会明确回到大厅。

注意：重连目前恢复的是**帧进度和传输通道**，不是从服务端下发状态快照。客户端仍依赖本地 `CombatManager.snapshotRing`、实体对账和确定性重放恢复视图与逻辑状态。

<a id="cross-client-hash"></a>

## 10. 跨端状态摘要与分叉告警

### 10.1 当前链路

```text
CombatManager.sampleStateHash（每 20 帧）
  → simulationState.hash().h32
  → QueueSend.sendStateHash
  → pendingStateHashes（容量 8）
  → RequestBlank(stateHash, hashFrameId)
  → Room.recordStateHash(player, frameID, hash)
  → FrameHashes[frame][playerID]
  → 两端不一致：DesyncDetected=true + RoomResponse.error 广播
```

`FrameHashes` 只保留约 64 帧，`DesyncDetected` 一局只触发一次告警。客户端收到 `RoomResponse.error` 后只发 `PhaserEvents.RoomError`；当前没有把该事件接到 `rollbackToFrame()`、`startDeterminismSelfCheck()` 或重开局流程，因此**分叉检测不是分叉恢复**。

### 10.2 已知实现边界

- `QueueSend.flushStateHashes()` 直接 `BackendWS.send()`，没有像普通心跳那样经过 `refreshAckFrameId()`；其中 `ackFrameId` 取发送瞬间值，可能与同时排队的 blank/操作不一致。
- `hashSimulationState()` 输出的 h32 是 8 位十六进制字符串；客户端 `parseInt(..., 16) >>> 0` 转成 `uint32` 上报，服务端按 `uint32` 比较，编码一致。
- `CombatManager.sampleStateHash()` 上报的是模拟状态；`elapsedFrameTime` 等端侧渲染调度量被明确排除在哈希之外。
- 分叉后是否继续对局目前由 UI/人决定，协议没有 `resync/rollback` 请求，也没有服务端下发的权威状态快照。

<a id="recovery-mechanisms"></a>

## 11. 回滚与恢复的真实入口

### 11.1 客户端快照环

- `SNAPSHOT_INTERVAL_FRAMES = 10`，`SNAPSHOT_RING_SIZE = 20`，即保留最近约 200 帧。
- 快照只在 `SyncManager.recvQueue.currentFrameId % 10 === 0` 的干净帧边界记录；不在等待网络帧时记录。
- `CombatManager.rollbackToFrame(frame)` 取不晚于目标帧的最近快照，调用 `restoreState(entry.state, "in-place")`，再执行 `recvQueue.restoreToFrame(entry.frameId)`。
- `restoreState()` 先恢复 seed、values、PRNG、entity、timer、physics，再恢复 frameId；`lastStateHash/lastStateHashFrame` 清零以便重新采样。
- `RuntimeStateBridge` 注册的实体恢复包含植物/怪物对账、投射物工厂重建、障碍恢复和关系引用解析；Rapier 通过 `World.restoreSnapshot()` 重建世界并重绑 `userData`。

### 11.2 确定性自检

`CombatManager.startDeterminismSelfCheck()` 只做客户端本地验证：

1. 选一个距当前帧 5~200 帧的旧快照。
2. 记录当前哈希为 `expectedHash`。
3. 回滚到旧快照。
4. 依赖 `QueueReceive.replayLog` 把已消费帧重新注入队列。
5. 主循环推进到原帧后发出 `DeterminismSelfCheckResult`，比较 `expectedHash` 与 `actualHash`。

当前源码中没有找到该方法的自动调用点，也没有在 `RoomError` 收到分叉告警时启动它；它是调试/验证入口，不是线上自动恢复策略。

### 11.3 一次性表现事件

`logicEvents` 保存 `{frame, eventId, type, sourceId, data}`，并进入状态快照。Entity 按 `eventId` 去重消费；回滚后重放同一事件不会重复播放音效/粒子。实体视图最终通过 `syncViewFromModel()` 按 Model 状态重建，不依赖旧 Tween 是否仍存在。

### 11.4 尚未闭合的恢复需求

- 服务端没有权威战局快照，无法把严重分叉的客户端“纠正”到正确世界。
- 客户端没有 `resync` 消息，也没有把 `RoomError("状态分叉")` 映射到回滚/自检/重连的自动策略。
- 重连只恢复帧进度；若本地快照环已失效或本地状态已污染，仍可能继续分叉。
- `BaseEntity.lastConsumedEventId` 是 Entity 私有字段；目前未见于 `captureLogicState()/restoreLogicState()`，回滚重建实体后一次性事件ID可能从头开始。
- `CombatManager.restoreState()` 未检查 `RestoreReport.ok/missing/errors`，恢复失败不会阻止继续模拟。
- `EntityTickManager.restore()` 用 `Math.max(nextTimerId, snapshot ids + 1)`，通常不会把 `nextTimerId` 回退到快照时的值；若回滚删除了高ID timer，后续新 timer 的 ID 可能与连续运行不同。

<a id="verification"></a>

## 12. 更新后的验证覆盖

### 12.1 单元测试与模型测试

`npm run test:core` 覆盖 5 组测试：

- `SimulationState.test.mjs`：稳定哈希、JSON round-trip、StateRegistry capture/restore。
- `Determinism.test.mjs`：连续运行 vs 多次 capture/restore、弱网周期回滚重放、断线冻结恢复、实体死亡回滚重建、buff/护盾/资源变化改变哈希。
- `LogicState.test.mjs` / `LogicModel.test.mjs`：Undo Log、帧号、事件队列、Model 字段回滚。
- `loadout.test.mjs`：两端规范化与摘要一致性。

最近一次 bugfix 记录显示核心测试为 23/23 通过（含寄存器覆盖补齐），但类型检查仍有既有 `SightLineEntity` 错误；本轮文档复查未重新运行完整构建。

### 12.2 Go 服务端测试

- `desync_test.go`：一端上报不判定、两端一致不判定、两端同帧不同哈希判定分叉；摘要表有界。
- `reconnect_test.go`：重连保留 `LatestFrameID/LatestAckFrameID`、连接代数递增，错误密钥/非 InGame 拒绝。
- `endgame_test.go`：双端投票、结果冲突判负、重复投票幂等。

### 12.3 多会话全链路模拟

`sim-debug/run-all.mjs` 是最近一次代码更新重点：

- `multi-session.mjs` 在真实 Go server 上并发建立多房间，每房两名模拟客户端。
- 双方运行同一无渲染确定性战局模拟器，按真实协议上报 `stateHash/hashFrameId` 和三类权威操作。
- 注入 1~5 个逻辑帧的双向逐包延迟；压测逻辑帧默认 2ms，生产服务端仍默认 50ms。
- 校验双方权威帧视图、三类操作、房间隔离、服务端权威结束帧/结果、补帧可达性和最终哈希。
- 同目录下的 `logic-world.mjs` 直接压测纯数据 Model 的全量快照恢复、Undo Log 回滚、事件去重和投射物字段快照。

仓库中 `sim-debug/run-console.log` 的最近一次结果为 **54/54 通过、0 失败**；其中 multi 用例 `A` 与 `B` 的最终 hash 一致，且两端都观察到服务端权威结束帧。该结果验证的是协议/服务端帧调度/确定性模拟的一致性，不等价于真实 Phaser 场景中所有实体和物理状态都能自动回滚恢复。

## 13. 开发检查清单

新增逻辑时问自己：

1. 这个状态会影响战斗结果吗？是则必须在 Model 或注册状态源中。
2. 字段是 JSON 安全的吗？否则改为 ID / 枚举 / 数字。
3. 延迟逻辑用的是 Model timer 吗？否则改用 `tickmanager.schedule()`。
4. 实体引用是否在 `LogicRelations.ts` 中声明？否则回滚后无法解析。
5. 随机数是否来自播种的 PRNG / `MobCmd.DeterministicRandom()`？
6. 表现事件是否通过 `logicEvents.emit()`，而不是直接播音效？
7. 重建实体时能否得到相同的 `SnapshotId` 和初始配置？
8. 新增上报字段是否区分 `frameId`（心跳进度）与 `hashFrameId`（摘要对应帧）？
9. 服务端或本地触发分叉告警后，是否有明确的恢复动作，而不是只打印事件？

<a id="post-fix-behavior"></a>

## 14. 修复后的运行时行为

### 14.0 预测式帧同步

权威模式下本地操作不再等待服务端帧才落地：

1. 玩家操作时记录 `PredictedOperation{clientOpSeq, uid, kind, pid, col, row}`。
2. 操作立即调用现有 `PlantsManager` 路径改变本地 Model，同时进入预测表并保存到操作前快照。
3. 服务端回包的 `InGameOperation.response_client_op_seq` 把权威操作关联到发起者；确认时只清理预测记录，不重复执行。
4. 服务端 `error` 回包按 `client_op_seq` 撤销预测：清虚影、删预测记录、恢复到操作前快照并重新执行后续已确认操作。
5. 因此回滚现在有真实用途：拒绝回包、分叉止损和 checkpoint 恢复都依赖同一套确定性快照机制。
6. 拒绝回包回滚时同时清空资源预演值与卡槽预演冷却，再按 `clientOpSeq` 顺序重放尚未确认的预测，避免 UI 显示与权威 Model 不一致。

高频 10 帧采样只写逻辑状态；`registerPhysics().capture` 返回 null，不再对 Rapier world 做 `takeSnapshot()`。

### 14.1 分叉处理

`RoomResponse.error` 的 message 含“状态分叉”时：

1. `BackendWS.enterDesyncOfflineMode()` 关闭 WS、取消重连并清空权威队列。
2. `CombatManager.enterDesyncOfflineMode()` 保留当前模拟世界，停止等待权威帧。
3. `SyncManager.update()` 在离线单机模式下自行推进 `currentFrameId`，本地操作直接落到 Model。
4. 暂停与倍速恢复可用；收益和星屑消耗按正常单机规则继续。
5. 左上角显示 `desync`；结算时 `Game.handleRoomGameEnd()` 调用 `exportDesyncLog()` 下载一次 JSON 报告。
6. 分叉态下 `BackendWS.isOnlineMode()` 返回 false，因此 HUD、暂停按钮、键盘快捷键和结算流程都不会再按在线模式拦截本地操作；日志导出有一次性标记，重复结算不会重复下载。

分叉本身说明确定性设计存在缺陷，因此系统不尝试多人 resync；离线单机只是止损，不是把它重新合并回多人对局。

### 14.2 Checkpoint 与追帧

- 客户端每 10 帧采样 32 位摘要，用于分叉检测。
- 每 200 帧（默认 10 秒）构造一次 checkpoint：不含 `physics`，体积超过 6KB 时只上报 hash。
- `RequestBlank.state_hash_hex` 传 8 位十六进制摘要，`inline_snapshot_json` 传可恢复状态；服务端只在双端 hash 一致时确认 `LastCheckpointFrame`。
- `ResponseCheckpointAccepted` 通知两端 checkpoint 已生效。
- 回放期间的权威操作先检查本地预测表：预测存在时只确认并清理；刷新/进程重建后预测表为空时，自己的历史权威操作也必须照常落地，避免快进漏掉操作。
- 重连后服务端发送 `ResponseReplayFrames`，包含从 `LastCheckpointFrame + 1` 到当前权威帧的所有历史操作，以及 `checkpoint_frame_id` 和已确认 checkpoint 的 `inline_snapshot_json`；客户端先用 `restoreInlineSnapshot()` 在 `rebuild` 模式恢复逻辑状态与 `currentFrameId`，再按 ACK 快进消费帧，期间新帧仍通过原有 `InGameResponse` 通道到达。
- `captureCheckpoint()` 上报的 `state_hash_hex` 固定为 8 位十六进制，和 32 位摘要心跳复用同一编码，避免双端以不同字符串格式上报导致 checkpoint 永远无法确认。
- 没有可用 checkpoint 时回退到最早历史帧；缺口仍无法覆盖时继续按 `RoomClosed` 要求重新加入。

### 14.3 回滚确定性

- `RestoreContext.nextTimerId` 来自快照中的 `ticker.nextTimerId`，`EntityTickManager.restore()` 精确回退。
- `BaseEntity.lastConsumedEventId` 进入 `extra`，重建实体不会重复消费一次性事件。
- `CombatManager.restoreState()` 保存并告警 `RestoreReport.ok/missing/errors`。
- 状态摘要心跳使用当前 `frameId` + 摘要专用 `hashFrameId`，避免污染 ACK 与补发边界。

### 14.4 验证记录

- 核心测试：29/29 通过。
- EntityTickManager 回滚专项：1/1 通过。
- inline 快照专项：3/3 通过（含 inline → SimulationState 恢复）。
- TypeScript 类型检查：`npx tsc --noEmit -p tsconfig.json` 无错误。
- Go `room-atom` 与 `game-logic`：通过，含 checkpoint 双端确认/摘要不一致用例。
- 客户端生产构建：成功。
- 回放快照专项：Go 测试验证已确认 checkpoint 的 inline 正文随 replay 返回。

旧的 11.4 节记录的是修复前状态；以本节和对应提交为准。
