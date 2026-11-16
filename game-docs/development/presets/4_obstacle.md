# 障碍物 Preset 开发指南

<a id="obstacle-overview"></a>

> 适用代码：`src/game/models/ObstacleModel.ts`、`src/game/models/entities/ObstacleEntity.ts`、`src/game/presets/obstacle/**`、`src/game/utils/cmd/ObstacleCmd.ts`
>
> 相关阅读：[Model 能力边界](../models/1_model.md#model-boundary)、[Entity 能力边界](../models/2_entity.md#entity-boundary)、[Cmd](../kit/2_cmd.md#cmd-overview)、[Boss 召唤](../presets/2_mob.md#mob-case-boss)

## 1. 组成

障碍物与植物类似，但通常是一次性战场对象：

```text
ObstacleModel 子类   // 血量、掉落、触发标记、生命周期逻辑
ObstacleEntity 子类  // 视图、Sensor、双格占位表现
ObstacleCmd          // 创建入口
ObstacleManager      // 按格与按行索引
```

现有障碍：

| oid | 文件 | 说明 |
| --- | --- | --- |
| 1 | `src/game/presets/obstacle/obsidian.ts` | 黑曜石柱，由 Obsidian Golem 召唤 |
| 2 | `src/game/presets/obstacle/mine_rock.ts` | 矿岩，占 1×2 格，摧毁后掉星碎 |

<a id="obstacle-model"></a>

## 2. Model 写法

`ObstacleModel` 的运行时字段自动进入快照：

```ts
public health = 0;
public extraRow = 0;
public dropped = false;
public hasTriggered = false;
```

生命周期钩子：

| 钩子 | 用途 |
| --- | --- |
| `onCreate(entity)` | 初始化占位、注册额外格 |
| `onHurt(entity, amount, realDamage)` | 受击分支 |
| `onDeath(entity)` | 掉落、清理额外格注册 |

Model 不保存 `summoner` 实体引用；`summoner` 是关系字段，由 Entity 持有并通过 `EntityLookup` 在回滚时恢复。

<a id="obstacle-entity"></a>

## 3. Entity 写法

`ObstacleEntity` 负责：

- 用 `PositionManager.getPlantBottomCenter(col, row)` 计算坐标。
- 创建动态 Sensor。
- 注册到 `ObstacleManager`。
- 管理 `summoner`、`underAttackBy` 等关系字段。
- 构建视图与额外格视图。

`ObstacleConfig`：

```ts
type ObstacleConfig = {
  hp: number;
  faction: Faction;
  summoner?: BaseEntity;
  waveId?: number;
};
```

`OBSTACLE_RELATION_FIELDS = ["summoner", "underAttackBy"]`，因此 Boss 召唤的障碍在回滚后仍能找回召唤者。

<a id="obstacle-create"></a>

## 4. 创建入口

统一使用：

```ts
ObstacleCmd.create(oid, scene, x, row, {
  hp,
  faction: Faction.ZOMBIE,
  summoner: entity,
});
```

或按格：

```ts
ObstacleCmd.createInGrid(ObsidianObstacleData.oid, entity.scene, col, row, {
  hp: 300,
  faction: Faction.ZOMBIE,
  summoner: entity,
});
```

内部流程：

```text
DeferredManager.defer
  → ObstacleLibrary.GetModel(oid).createEntity(...)
  → initializeEntity()
  → ObstacleManager.RegisterObstacle()
  → model.onCreate(entity)
```

不要直接 `new ObstacleEntity(...)`，否则不会进管理器索引，也无法被快照收集。

<a id="obstacle-grid"></a>

## 5. 多格占位

矿岩占 1×2 格：

- `row` 是主格。
- `extraRow = row + 1` 写入 Model。
- `ObstacleManager.ObstaclesMap[${col}-${extraRow}]` 与 lane alias 也注册同一实体。
- 销毁时清理主格与额外格注册。

这种“额外占位”必须写成 Model 字段，回滚后才能恢复占位关系。视图只是按 `extraRow` 画更大的 sprite / 碰撞体。

<a id="obstacle-summoner"></a>

## 6. summoner 与回滚

Boss 技能生成障碍时传 `summoner: entity`：

```ts
ObstacleCmd.createInGrid(ObsidianObstacleData.oid, entity.scene, col, row, {
  hp,
  faction: Faction.ZOMBIE,
  summoner: entity,
});
```

快照阶段：

```text
summoner → encodeEntityRef → "entity:<SnapshotId>"
```

恢复阶段：

```text
EntityLookup.resolveEntity(SnapshotId) → 当前存活实体
```

若召唤者已死亡或 rebuild 失败，会记录 `report.missing`。业务上不要让 Model 持有召唤者的强引用，也不要把召唤者 id 写死在配置里。

<a id="obstacle-case-obsidian"></a>

## 7. 用例：黑曜石柱

代码：`src/game/presets/obstacle/obsidian.ts`。

- oid=1。
- 由 `ObsidianGolemModel` 技能生成。
- Model 只定义基础血量与生命周期。
- Entity 提供黑曜石 sprite 与 sensor。
- 生成来源通过 `summoner` 关系字段记录。

Boss 侧的完整链路：

```text
GolemCast(skill2)
  → ObsidianGolemModel.skill2()
  → spawnColumn()
  → ObsidianColumn 事件（延迟 800ms + index*600ms）
  → ObsidianObstacleSpawn 事件（1200ms 后）
  → ObstacleCmd.createInGrid(..., summoner)
  → PlantCmd.DealDamage(...)
```

<a id="obstacle-case-minerock"></a>

## 8. 用例：矿岩

代码：`src/game/presets/obstacle/mine_rock.ts`。

- oid=2。
- 1×2 格占位，`extraRow = row + 1`。
- 由 `CentipedeModel.rockImpact()` 在落石技能中生成。
- `dropped` 字段保证星碎只掉一次。
- 摧毁时 `ResourceCmd.AddStarshardToAll(1)`。

要点：

```ts
if (!this.dropped) {
  this.dropped = true;
  ResourceCmd.AddStarshardToAll(1);
}
```

`dropped` 必须进 Model 快照，否则回滚到未掉落帧后可能重复发奖。

<a id="obstacle-rollback"></a>

## 9. 回滚边界

障碍快照由 `RuntimeStateBridge` 注册：

```ts
collectEntities("obstacle", flattenMapValues(ObstacleManager.Instance.ObstaclesMap))
```

恢复时调用 `restoreEntityValues()`。当前策略是：

- 已存在障碍：回写 Model 字段、位置、关系。
- 缺失障碍：上报 missing；障碍没有通用 rebuildFactory，通常由技能事件重放或实体重建流程补回。
- 多余障碍：删除。

因此新障碍 preset 必须保证：

1. 所有影响结果的状态都是 Model 的 JSON 安全字段。
2. 额外格注册可由 `extraRow` 恢复。
3. 召唤关系通过 `summoner` 字段表达。
4. 奖励/触发标记使用布尔字段防重复。

## 10. 检查清单

- [ ] 创建走 `ObstacleCmd.create/createInGrid`。
- [ ] 血量、占位、掉落标记在 Model。
- [ ] Entity 只做视图、Sensor 和注册。
- [ ] 多格占位有 `extraRow` 等快照字段。
- [ ] 召唤者通过 `summoner` 关系字段表达。
- [ ] 一次性奖励有 `dropped` / `hasTriggered` 防重。
- [ ] 不在 Model 中保存实体引用或 Phaser 对象。
