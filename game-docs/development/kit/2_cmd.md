# Cmd 命令层

<a id="cmd-overview"></a>

> 适用代码：`src/game/utils/cmd/**`
>
> 相关阅读：[Manager 与固定步长循环](./1_manager.md#3-固定步长主循环)、[Entity 能力边界](../models/2_entity.md#entity-bridge)、[回滚与同步](../models/3_rollback_and_sync.md#rollback-overview)

Cmd 是“请求修改游戏世界”的薄封装。它的价值不在封装多少代码，而在于统一两件事：

1. **延迟执行**：模拟状态变更通过 `DeferredManager.defer()` 入队，在帧边界执行。
2. **集中入口**：实体创建、伤害、资源变化、障碍物生成都有单一调用点，便于审计和回滚。

## 1. 何时使用 Cmd

| 场景 | 是否需要 Cmd | 原因 |
| --- | --- | --- |
| 生成怪物 / 植物 / 障碍物 / 投射物 | 需要 | 必须 defer，且需要登记稳定 id |
| 造成伤害、设置血量、设置睡眠 | 需要 | 会影响 Model 状态与快照 |
| 增加能量 / 星碎 | 需要 | 资源状态参与快照 |
| 播放音效 / 粒子 / Tween | 不需要 | 纯表现，不进快照 |
| Model 内部字段自增（冷却计数、技能阶段） | 不需要 | 已由 Model 的 Proxy 自动记录 |

## 2. 世界变更类 Cmd

### MobCmd

```ts
MobCmd.Spawn(mid, scene, col, row, waveId, onSpawned?);
MobCmd.DamagePlantsArea(col, row, colSpan, rowSpan, damage);
MobCmd.DamagePlantsInCells(cells, damage);
MobCmd.EmitBossHealth(entity);
MobCmd.AnnounceBossSkill(scene, bossName, skillName);
MobCmd.DeterministicRandom(min, maxExclusive);
```

约束：

- `Spawn` 内部 defer 创建，并通过 `MobManager` 注册稳定 key `mob:${waveId}:${spawnSeq}`。
- 伤害类接口同样 defer，避免在 Rapier 碰撞回调中直接改血量。
- 随机数只能用 `MobCmd.DeterministicRandom()`（底层是 `MobManager.SeedRandom`），禁止在 Model 中用 `Math.random()`。

### PlantCmd

```ts
PlantCmd.Create(...);
PlantCmd.SetHealth(entity, value);
PlantCmd.DealDamage(entity, damage, dealer, source);
PlantCmd.SetSleeping(entity, sleeping);
```

`PlantCmd` 源码注释明确要求：所有会改变植物状态的操作都走 Cmd，禁止直接 `entity.currentHealth = ...` 或直接 `entity.setSleeping()`。

### ProjectileCmd

```ts
ProjectileCmd.Create(ModelClass, scene, x, row, config);
ProjectileCmd.CreateExplosion(scene, x, row, config);
ProjectileCmd.CreateLaser(scene, x, row, config);
```

创建后会自动：

1. defer 生成实体并 `initializeEntity()`。
2. 加入 `activeProjectiles`。
3. 记录 `rebuildFactories`，用于 rebuild 模式恢复投射物。

### ObstacleCmd

```ts
ObstacleCmd.create(oid, scene, x, row, config);
ObstacleCmd.createInGrid(oid, scene, col, row, config);
```

`createInGrid()` 内部用 `PositionManager.getPlantBottomCenter(col, row)` 计算 x，并对 col/row 做 clamp。Boss 技能生成障碍时应传入 `summoner: entity`，用于关系快照。

### ResourceCmd

```ts
ResourceCmd.AddEnergyToAll(amount);
ResourceCmd.AddStarshardToAll(amount);
```

只做转发，最终由 `ResourceManager` 更新状态。

## 3. 表现类 Cmd

### SfxCmd

```ts
SfxCmd.Create(Ctor, args);
```

约束：Sfx 只能负责视觉表现，**不得**在 `onComplete` 中创建实体、造成伤害或改变实体状态。需要“动画结束后执行逻辑”时，在调用处用 Model 的 `tickmanager.schedule()` 另行调度。

### SoundCmd

```ts
SoundCmd.PlayPlant(name);
SoundCmd.PlayZombieSpawn(index);
SoundCmd.PlayShootLaser();
SoundCmd.CoverBgm(key);
SoundCmd.BackToPreviousBgm();
```

纯音效封装，不影响模拟。

## 4. 用例：在 Model 中正确发起世界变更

下面的例子来自 Boss Model 的岩柱技能：Model 决定点哪一行、延迟多久、造成多少伤害；Cmd 负责把创建障碍和伤害植物放到帧边界执行。

```ts
private createObstacleAndDamage(entity: BaseGolemEntity, col: number, row: number, hp: number): void {
  ObstacleCmd.createInGrid(ObsidianObstacleData.oid, entity.scene, col, row, {
    hp,
    faction: Faction.ZOMBIE,
    summoner: entity,
  });

  const plants = PlantsManager.Instance.PlantsMap.get(`${col}-${row}`) ?? [];
  for (const plant of [...plants]) {
    PlantCmd.DealDamage(plant, DamageConstants.SECKILL / 2, entity);
  }
}
```

注意：

- `PlantsManager.Instance.PlantsMap.get(...)` 是查询，不修改状态，可以直接读。
- 延迟由 `this.tickmanager.schedule(...)` 负责，不用 `scene.time.delayedCall`。
- `summoner` 会被写入障碍的关系字段，回滚时通过 `EntityLookup` 解析。

## 5. 常见错误

| 错误写法 | 后果 | 正确写法 |
| --- | --- | --- |
| Model 中直接 `new ZombieEntity(...)` | 脱离 MobManager，快照无法对账 | `MobCmd.Spawn(...)` |
| Model 中直接 `plant.currentHealth -= x` | 绕过帧边界，可能落在物理借用期 | `PlantCmd.DealDamage(...)` |
| 用 `Math.random()` 选目标 | 回滚重放结果不一致 | `MobCmd.DeterministicRandom(...)` |
| 用 `scene.time.delayedCall()` 触发逻辑 | 不进快照，暂停/回滚后产生幽灵回调 | `this.tickmanager.schedule(...)` |
| 在 Sfx 的 `onComplete` 里改血量 | 表现对象携带逻辑，无法回滚 | Model 定时事件 |

## 6. 与回滚的关系

Cmd 本身不保存状态。它只是把请求送到正确的管理器；真正需要恢复的是执行后的结果：

- 实体字段：由 [Model 的 LogicState 快照](../models/1_model.md#model-rollback) 保存。
- 位置 / 刚体：由 [Entity 快照](../models/2_entity.md#entity-rollback) 保存。
- 资源、波次、网格：由对应 Manager 的状态源保存。
- 延迟中的逻辑：由 [Model 定时器](../models/1_model.md#model-tick) 保存。

详见 [回滚与同步](../models/3_rollback_and_sync.md#rollback-state-layout)。
