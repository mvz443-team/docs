# 投射物 Preset 开发指南

<a id="projectile-overview"></a>

> 适用代码：`src/game/models/entities/ProjectileEntity.ts`、`src/game/models/projectiles/**`、`src/game/presets/bullet/**`、`src/game/utils/cmd/ProjectileCmd.ts`
>
> 相关阅读：[Model 能力边界](../models/1_model.md#model-boundary)、[Entity 能力边界](../models/2_entity.md#entity-boundary)、[Cmd](../kit/2_cmd.md#cmd-overview)、[植物同格优先级](./1_plant.md#plant-priority)

## 1. 组成

投射物分三层：

```text
ProjectileModel 子类       // 伤害、穿透、速度、命中效果
ProjectileEntity 子类      // 视图、飞行插值、碰撞体
ProjectileCmd              // 创建、登记、快照对账
```

现有类型：

| 类型 | Model | Entity | 典型用途 |
| --- | --- | --- | --- |
| 箭矢 | `BulletModel` / `ArrowModel` | `ArrowEntity` / `BulletEntity` | 植物射击、骨架弓手 |
| 爆炸 | `ExplosionModel` | `ExplosionEntity` | 炸弹、雷增强、范围伤害 |
| 激光 | `LaserModel` | `LaserEntity` | 南瓜激光、Warden 激光 |
| 烟花 / 雪球 / 矿车 | 对应 preset Model | 对应 Entity | 特殊关卡交互 |

<a id="projectile-model"></a>

## 2. Model 写法

`ProjectileModel` 提供通用字段：

- `damage`
- `penetratePower` / `penetratedCount`
- `couldAttackFlying`
- `bounceable`
- `skipTiny`
- `range`

通用 `applyEffect(entity, target)` 流程：

1. 命中目标后计算真实伤害。
2. 穿透次数与伤害衰减（`penetratedPunish`）。
3. 应用 debuff / 增强。
4. 穿透耗尽时 `entity.destroySelf()`。

`ArrowModel` 示例：

- `enhancement` 字段进入快照。
- 火：伤害 ×1.5。
- 雷：触发 `createExplosion()`。
- 冰：`applyDebuffTo(target, "slow", 5000)`。

新增投射物 Model 时，不要保存 Sprite、Tween 或刚体引用；命中效果里的世界变更通过 `host` 或 Cmd 发起。

<a id="projectile-entity"></a>

## 3. Entity 写法

`ProjectileEntity` 负责：

- `createSensor(width, height, angle)` 创建 kinematic sensor。
- 飞行插值和越界/超距销毁。
- `hasAttackedSet` 防止同一目标多次命中。
- 把碰撞目标过滤后交给 `model.applyEffect(this, target)`。

过滤规则：

1. 目标必须是 `CombatEntity`。
2. 已命中目标跳过。
3. 同阵营跳过。
4. 目标飞行 / 虚空规则跳过。

Entity 只处理“哪些目标可以进入命中判定”，不决定伤害数值。

<a id="projectile-create"></a>

## 4. 创建与登记

统一使用 `ProjectileCmd`：

```ts
ProjectileCmd.Create(ArrowModel, entity.scene, entity.x, entity.row, {
  damage: this.damage.getValueAt(entity.level),
  faction: Faction.PLANT,
  speed: 900,
  penetratePower: config.penetratePower,
});
```

内部流程：

```text
DeferredManager.defer
  → ProjectileLibrary / model.createEntity
  → initializeEntity()
  → activeProjectiles 登记
  → rebuildFactories 记录（上限 512）
```

不要直接 `new ArrowEntity(...)`，否则快照对账无法重建。

<a id="projectile-collision"></a>

## 5. 碰撞与同格优先级

`BulletEntity.onCollision()` 命中植物时，会调用 `PlantHelper.GetPlantsInGrid(col, row)`，然后递归寻找更高优先级植物：

```text
current = 命中的植物
applyEffect(current)
  → 穿透次数是否耗尽
  → candidate = 同格中 IsMorePriorityPlant(candidate, current) 的植物
  → applyEffect(candidate)
```

这保证“子弹从承载物打到承载物上的植物”“护盾优先”等行为与僵尸啃食一致。完整优先级规则见 [植物同格优先级](./1_plant.md#plant-priority)。

<a id="projectile-lifecycle"></a>

## 6. 生命周期与回滚

### 箭矢 / 子弹

- 每步检查是否超过最大距离或世界边界。
- 命中后按穿透次数决定销毁。
- `hasAttackedSet` 防止重复命中，套装内容不进入快照；回滚后实体通常重建或按当前命中状态继续。

### 爆炸

`ExplosionEntity` 根据 `leftGrid/rightGrid/upGrid/downGrid` 计算碰撞区域和中心偏移，播放 `ExplosionSfx`，Model timer 110ms 后销毁。

### 激光

`LaserEntity` 计算中点与角度，创建旋转 Sensor 和 glow/beam/core 三段视图。invisible 模式按 duration 定时销毁，否则 Tween + 兜底 Model timer。

### 快照对账

`ProjectileCmd.captureProjectileSnapshots()` 导出投射物实体快照，注册在 `RuntimeStateBridge`。恢复时：

- 多出的投射物销毁。
- 缺失的投射物按 `rebuildFactories` 复活并 `adoptStableSnapshotKey()`。
- 无工厂则记录 `report.missing`。

投射物不支持“凭空恢复”：工厂必须能根据快照中的 `kind/config` 重建。

<a id="projectile-case-arrow"></a>

## 7. 用例：箭矢增强

代码：`src/game/presets/bullet/arrow.ts`。

```text
ArrowModel
  ├─ enhancement: "none" | "fire" | "lightning" | "ice"
  └─ applyEffect()
       ├─ fire      → damage × 1.5
       ├─ lightning → createExplosion(...)
       └─ ice       → applyDebuffTo(target, "slow", 5000)

ArrowEntity
  ├─ 尾迹 / 音效
  └─ 不决定增强效果
```

增强字段随快照恢复，因此回滚重放后命中效果一致。

<a id="projectile-case-explosion-laser"></a>

## 8. 用例：范围与持续区域

### 爆炸

- 由 `ProjectileCmd.CreateExplosion()` 创建。
- 碰撞体尺寸由格数换算，中心按 left/down 偏移修正。
- 纯视觉 `ExplosionSfx` 不携带逻辑。
- 逻辑销毁使用 Model 的 timer，不用 Tween `onComplete`。

### 激光

- 由 `ProjectileCmd.CreateLaser()` 创建。
- `LaserModel.createEntity()` 根据 row 计算 y0 与终点 x2。
- `LaserEntity` 只创建显示对象与旋转 Sensor。
- duration 是逻辑状态，决定伤害窗口与销毁时机。

## 9. 检查清单

- [ ] 创建统一走 `ProjectileCmd`。
- [ ] 伤害 / 穿透 / debuff 在 Model。
- [ ] Entity 只做视图、飞行插值和碰撞过滤。
- [ ] 同格植物优先级委托 `PlantHelper`。
- [ ] 一次性投射物有稳定的销毁条件。
- [ ] 需要 rebuild 的投射物注册了 `rebuildFactories`。
- [ ] 不用 `scene.time.delayedCall()` 承载逻辑。
