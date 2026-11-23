# 关卡、波次与网格

<a id="stage-data"></a>

> 适用代码：`src/types/stage.ts`、`public/stages/levels/ch*.json`、`src/game/utils/helper/StageHelper.ts`、`src/game/managers/combat/MobManager.ts`、`PresetEventManager.ts`、`GridManager.ts`
>
> 相关阅读：[Manager 职责](../kit/1_manager.md#2-核心-manager-速查)、[僵尸 preset 的长度与权重](../presets/2_mob.md#mob-overview)、[回滚状态源](./3_rollback_and_sync.md#rollback-state-layout)

## 1. 关卡数据从哪里来

`Game.create()` 从缓存读取 `ch${level}` JSON，得到 `StageData`。

核心类型：

```ts
interface StageScript {
  first_wave_id: number;
  total_waves: number;
  base_difficulty: number;
  difficulty_limit: number;
  phase1_end: number;
  phase2_end: number;
  dayOrNight: number;       // 1=白天开局，2=夜晚开局
  flagWaves: number[];
  AllowedMobs: number[];
  globalRatio: number;
  bossInsert: unknown[];
}

interface Wave {
  waveId: number;
  progress: number;
  monsters: unknown[];
  duration: number;
  maxDelay: number;
  minDelay: number;
  exceptLine: number;
  starShards: number;
}
```

真实关卡文件位于 `public/stages/levels/ch1.json` 到 `ch9.json`。`ch1.json` 的示例配置包含 12 波、白天开局、水道行 `[1,2,3]`、允许怪物 `[1,2,3,8]`。

<a id="stage-generation"></a>

## 2. StageHelper 生成波次

`StageHelper.generateStageScript()` 是关卡脚本生成器。它决定：

- 难度曲线：三段式（二次 / 指数 / Logistic）随波次提升。
- flag 波：难度系数 ×2.5。
- 行选择：用 `lastPicked` / `secondLastPicked` 抑制连续重复行，前 3 波避开水道。
- 时间间隔：每波 `duration=5000ms`，`minDelay/maxDelay` 决定怪间隔。
- 星碎：每 5 波 +1，每 15 波额外 +1。
- Boss / elite 波：按 `bossInsert` 插入。
- 首波不刷怪，仅作为准备波。

`generateBossWaveScript(baseLevelSum, rng, AllowedMobs, callIdx)` 供 Boss Model 召唤小弟，例如 Golem 的 `GolemModel.callMob()`。

不要在 Model 中直接读关卡 JSON 生成随机波次；Boss 也只调用 `generateBossWaveScript()` 并把结果交给 `MobCmd.Spawn()`。

<a id="stage-waves"></a>

## 3. MobManager 消费波次

`MobManager` 负责把 `Wave` 变成实际怪物：

```text
startFirstWave / nextWave
  → StageHelper 生成当前波脚本
  → Wave 定时器推进（TickerManager.addEvent, snapshot.kind = "mob.spawn"）
  → MobHelper.createSpawnPlan 规划本波怪物
  → DeferredManager.defer(...)
  → MonsterLibrary.GetModel(mid).createEntity(...)
  → MobManager.registerMonster(...)
```

稳定身份：

- `spawnSeq` 单调递增。
- `adoptStableSnapshotKey('mob:${waveID}:${spawnSeq}')`。
- `MonsterModel.applySpawnSeed()` 用 seed、waveId、col、row、spawnSeq 计算出生偏移。

击杀数、波次状态、刷怪 PRNG 都参与快照。详见 [僵尸 preset](../presets/2_mob.md#mob-lifecycle)。

<a id="stage-grid-daynight"></a>

## 4. 网格与昼夜

`GridManager` 维护每格类型：

```ts
type GridPropertyType = "ground" | "water" | "void" | "sky";
```

`RowPropertyRatio(row, type)` 缓存每行各地形占比，供出怪权重与放置规则使用。

**地形通行域**：`src/game/core/logic/TerrainHabitat.ts` 用 `dominantHabitat()` 按占比判定行的主地形（水面占比严格 > 0.5 为 `water`，天空严格 > 0.5 为 `air`，否则 `ground`），`canSpawnMonsterInRow()` 过滤不能在该地形行动的怪物（飞行怪无视限制）。调用点在 `MobHelper.selectSpawnRow()`：按 `rowPropertyRatio` 组装 `RowTerrainRatio` 后过滤行权重，全不匹配时回落到基础权重。这样木船僵尸/潜水僵尸只在水行刷出，地面僵尸不会刷到纯水面行。`StageHelper.generateStageScript()` 仍只用 `exceptLine` 让前 3 波避开水道，不在这里按占比过滤。

`PositionManager.setStageGrid(...)` 设置网格尺寸与缩放，然后 `GridManager.initGridProperties()` 默认全为 ground。

昼夜由 `StageScript.dayOrNight` 决定：

- `1`：白天开局。夜间植物会自动睡眠。
- `2`：夜晚开局。

`PresetEventManager` 在 waveId=0 时：

1. 初始化网格属性。
2. 设置初始能量。
3. 设置 `combatStatus.dayOrNight`。
4. 白天启动自动产能 `startAutoGenerateEnergy(17000, 25000, 25)`。

`Chapter1Dispatch()` 还会按 stageId 预置植物、暗幕、水道和睡莲，并为 stage9 注册蜈蚣 hooks。

<a id="stage-resources"></a>

## 5. 资源与卡牌

`ResourceManager` 管理两种资源：

| 资源 | 来源 | 上限 |
| --- | --- | --- |
| energy | 初始能量、自动产能、阳光类掉落 | 由关卡/配置决定 |
| starShards | 波次奖励、掉落、击杀 | 10 |

`ResourceCmd.AddEnergyToAll()` / `AddStarshardToAll()` 是唯一修改入口，见 [Cmd](../kit/2_cmd.md#2-世界变更类-cmd)。

`CardpileManager` 管理：

- 当前选中卡牌（植物 / 铲子 / 星碎）。
- 每张卡只保存 `cooldownEndFrame`（权威帧号）、`previewPending` 与 `totalMs`，**不逐帧递减冷却，也不把剩余毫秒数写进快照**。
- 剩余时间由 `cooldownLeftMsAt(currentFrame)` 从权威帧推导：`currentFrame()` 优先取 `recvQueue.currentFrameId`（离线时回落到 `getAuthoritativeFrame()`）。
- `reloadCard(pid, plantFrame)` 用操作的权威帧重置结束帧；重连/profile 恢复时用 `cooldownEndFrameFromProfile()` 换算。`stepUpdate()` 只广播展示进度。

预显示（preview）只用于本地乐观交互，不代表权威状态；profile 里上报的 `card_cooldowns` 只在本地帧号追上 profile 帧号后套用，跳帧恢复时丢弃。

<a id="stage-boss-script"></a>

## 6. 与 Boss 技能的边界

Boss 可以请求一段波次脚本，但不能自己决定全局关卡流程：

```ts
const records = StageHelper.generateBossWaveScript(
  levelSum, entity.getRandom(), allowed, this.callCount,
);
```

之后：

- `callCount++` 写入 Model 快照。
- `pendingSpawns` 写入 Model 快照。
- `MobCmd.Spawn()` 负责真正生成。
- 随机源来自 Entity 的播种 PRNG，PRNG 状态通过 `MONSTER_PRNG_FIELDS` 快照。

这保证 Boss 召唤在回滚重放后仍然得到同一批怪物和同一顺序。
