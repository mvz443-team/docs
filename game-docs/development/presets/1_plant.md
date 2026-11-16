# 植物 Preset 开发指南

<a id="plant-overview"></a>

> 适用代码：`src/game/models/PlantModel.ts`、`src/game/models/entities/PlantEntity.ts`、`src/game/presets/plant/**`、`src/game/utils/helper/PlantHelper.ts`
>
> 相关阅读：[Model 能力边界](../models/1_model.md#model-boundary)、[Entity 能力边界](../models/2_entity.md#entity-boundary)、[回滚与同步](../models/3_rollback_and_sync.md#rollback-overview)、[Cmd](../kit/2_cmd.md#cmd-overview)

## 1. 文件组织

每个植物 preset 通常在一个文件里包含三部分：

```text
XxxModel extends PlantModel   // 数值定义 + 攻击/星碎/睡眠决策
XxxEntity extends PlantEntity // buildView + 动画/特效方法
export const XxxData = new XxxModel(...)
```

`XxxData` 只是模板。`BaseEntity` 构造时会 `cloneLogicModel()`，每个场上的植物拿到独立 Model 副本。不要把场上状态写在 `XxxData` 上。

<a id="plant-lifecycle"></a>

## 2. 生命周期

```text
PlantsManager.TryPlant
  → 卡片冷却 / 能量 / CanPlantInGrid 校验
  → PlantCmd.Create / DeferredManager.defer
  → PlantModel.createEntity(scene, col, row, level)
  → initializeEntity()
      ├─ adoptStableSnapshotKey(`plant:${col}:${row}:${pid}`)
      ├─ buildView()
      ├─ AttachBadgeView()
      ├─ buildPhysics()          // dynamic + sensor
      ├─ PlantsManager.RegisterPlant()
      ├─ 夜间植物白天自动睡眠
      └─ model.onCreate(this)
```

`PlantEntity` 的 `takeDamage/onHurt/useStarShards/onDeath/setSleeping` 都只转发给 Model 或更新表现。

<a id="plant-model"></a>

## 3. Model 写法

`PlantModel` 负责：

- 静态数值：`maxHealth / cost / cooldown / damage`，通常用 `LevelScaledValue`。
- 运行时状态：`level / isSleeping / shieldHealth / damagedSum / inBruteShoot / fuse / hasExploded` 等。
- 攻击时序：用 `this.tickmanager.schedule()` 或兼容的 `delayedCall()`。
- 目标判定：读取 SightLine 查询结果，决定是否攻击。
- 星碎逻辑：`onStarShards()`。
- 受击 / 死亡逻辑：`onHurt()` / `onDeath()`。

骨骼：

```ts
export class MyPlantModel extends PlantModel {
  public override pid = 999;
  public override nameKey = "name_my_plant";
  public override descriptionKey = "my_plant_description";
  public override texturePath = "plant/my_plant";

  public maxHealth = new LevelScaledValue(300);
  public cost = new LevelScaledValue(100);
  public cooldown = new LevelScaledValue(5000);
  public cooldownStartAtRatio = 0;
  public damage = new LevelScaledValue(20);
  public isNightPlant = false;

  public override createEntity(scene, col, row, level): MyPlantEntity {
    return this.initializeEntity(new MyPlantEntity(scene, col, row, level));
  }

  public override onCreate(entity: MyPlantEntity): void {
    entity.setSightLine(/* ... */);
    this.tickmanager.addEvent({
      startAt: 800,
      delay: 1000,
      repeat: -1,
      callback: () => this.tryShoot(entity),
    });
  }

  private tryShoot(entity: MyPlantEntity): void {
    if (entity.isSleeping || this.inBruteShoot) return;
    if (!entity.hasSightTarget()) return;
    entity.playShootAnimation();
    this.tickmanager.delayedCall({
      delay: 200,
      callback: () => this.shoot(entity),
    });
  }

  private shoot(entity: MyPlantEntity): void {
    if (entity.currentHealth <= 0) return;
    ProjectileCmd.Create(ArrowModel, entity.scene, entity.x, entity.row, {
      damage: this.damage.getValueAt(entity.level),
      faction: Faction.PLANT,
      speed: 900,
    });
  }
}
```

推荐把新增技能 timer 改成枚举事件，并把事件名加入 `tickEventNames`；详见 [Model 定时器](../models/1_model.md#model-tick)。

<a id="plant-entity"></a>

## 4. Entity 写法

Entity 负责：

- `buildView()`：Sprite 帧、缩放、层级。
- 动画方法：`playShootAnimation()`、`playRecoil()`、`playBruteShootAnimation()`。
- SightLine 对象的创建与查询封装。
- 纯表现 Tween。
- PRNG 对象（若需要，并加入 `PLANT_PRNG_FIELDS`）。

```ts
export class MyPlantEntity extends PlantEntity {
  declare public model: MyPlantModel;

  private sightLine!: SightLineEntity;

  constructor(scene: Game, col: number, row: number, level: number) {
    super(scene, col, row, MyPlantData, level);
  }

  public setSightLine(line: SightLineEntity): void {
    this.sightLine = line;
  }

  public hasSightTarget(): boolean {
    return this.sightLine.hasTarget();
  }

  protected override buildView(): void {
    const size = PositionManager.Instance.getPlantDisplaySize();
    const sprite = this.scene.add.sprite(this.x, this.y, this.model.texturePath)
      .setOrigin(0.5, 1)
      .setDisplaySize(size.sizeX, size.sizeY);
    this.viewGroup.add(sprite);
  }

  public playShootAnimation(): void {
    this.scene.tweens.add({ targets: this.viewGroup, alpha: 0.8, yoyo: true, duration: 80 });
  }
}
```

不要在 Entity 中决定“有没有目标就发射”；它只暴露 `hasSightTarget()` 和 `playShootAnimation()`。

<a id="plant-attack-check"></a>

## 5. 攻击定时器触发前的判定

普通射击植物的判定链必须按以下顺序：

```text
tick 到点
  ├─ 植物是否死亡 / currentHealth <= 0
  ├─ 是否睡眠 isSleeping
  ├─ 是否处于暴力发射 inBruteShoot
  ├─ SightLine.hasTarget()
  ├─ playShootAnimation()
  └─ delayedCall(约 200ms)
       └─ 再次确认存活 → ProjectileCmd.Create(...)
```

以 `dispenser.ts` 为例：

- `startAt: 800`，`delay: 1000`，无限循环。
- 每次 tick 先看 `isSleeping` 与 `inBruteShoot`。
- 有目标才播放射击动画。
- 动画中途 200ms 后真正生成箭。
- `normalShot()` 带 `penetratePower`，决定穿透能力。

`pumkin.ts` 同样在 tick 中检查睡眠和暴力发射，命中后 100ms 发激光；9 级以上附 `slow` debuff。

暂停由 `CombatManager` 保证：暂停时不会 `updateAllTickManagers()`，所以 Model timer 自动停止。`scene.time.delayedCall()` 不受逻辑暂停影响，不能承载战斗逻辑。

<a id="plant-priority"></a>

## 6. 同格多个植物的优先级机制

一个格子可以同时存在承载物（睡莲 / 小船）、主植物、护盾、魔法粉等。`PlantsManager.PlantsMap` 的 key 是 `${col}-${row}`，value 是植物数组。

### 6.1 僵尸转移啃食目标

`PlantHelper.IsMorePriorityPlant(prevPlant, newPlant)` 的规则：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `prev.pid === new.pid` | 不转移 |
| 2 | `prev` 是承载物（lily pid=6 / boat pid=100），`new` 不是 | 转移 |
| 3 | `new` 是护盾，`prev` 不是 | 转移 |
| 4 | `new` 是魔法粉 | 无条件转移 |
| 5 | 其他 | 不转移 |

调用链：

```text
Rapier collision
  → Game.handleCollision
  → MonsterEntity.onCollision
  → MonsterModel.onCollision
  → MonsterModel.tryStartAttack
      └─ IsMorePriorityPlant(current, target)
          → stopAttacking()
          → attacking = target
          → target.underAttackBy.add(entity)
          → 重新挂攻击 timer
```

目标死亡时反向清理：`PlantEntity.destroy()` 遍历 `underAttackBy`，让所有 attackers 执行 `stopAttacking()`，僵尸恢复移动，等待下一次碰撞重新选目标。

### 6.2 子弹穿透同格植物

`BulletEntity.onCollision()` 命中植物后：

```text
PlantHelper.GetPlantsInGrid(col,row)
  → applyEffect(current)
  → 穿透次数判定
  → 在同格中找 IsMorePriorityPlant(candidate, current) 的植物
  → 继续命中更高优先级目标
```

这保证“先打承载物、后打上面植物”或“护盾优先”的行为在子弹穿透时同样成立。

### 6.3 铲除 / 星碎选择

`PlantHelper.GetHighestPriorityPlant(plants, pointer)` 用于玩家操作：

| 场景 | 规则 |
| --- | --- |
| 只有 1 个植物 | 直接返回 |
| 2 个植物且有承载物 | 优先非承载物 |
| pointer=down | 优先护盾 |
| pointer=up | 优先非护盾、非承载物 |

种植侧兼容规则在 `PlantHelper.CanPlantInGrid()`：高级植物基座关系 `11→9`、`14→1`，以及 GROUND_ONLY / WATER_ONLY / SKY_ONLY / POWDER / carrier 冲突。

<a id="plant-case-dispenser"></a>

## 7. 用例：单发豌豆

代码：`src/game/presets/plant/chapter1/dispenser.ts`

- Model：`pid=1`，`DispenserModel.onCreate()` 建立正向 SightLine，1000ms 循环攻击。
- 特殊交互：`onStarShards()` 用 `inBruteShoot` 防重入，安排 50 发、50ms 间隔的暴力发射。
- Entity：`DispenserEntity` 使用 base/head 双 Sprite，`ShootHeadAnimationHelper.playRecoil()` 做后坐力。

实现同类植物时只需替换：

1. `damage / cooldown / pid / texturePath`。
2. SightLine 的方向与过滤条件。
3. `shoot()` 生成的投射物 Model 与参数。
4. Entity 的 `buildView()` 与射击动画。

<a id="plant-case-double"></a>

## 8. 用例：双发射手

代码：`src/game/presets/plant/chapter2/double_dispenser.ts`

- `SightLineGroup({ directions: [-1, 1] })` 同时看前后。
- 正向箭与反向箭分别由不同 timer 调度，反向箭速度为负。
- Lv3 / Lv7 追加箭，星碎期间前方 35 发并周期追加烟花。
- 所有追加发射都走 Model timer，并记录 `inBruteShoot` 防重入。

要点：多个 timer 同时存在时，每个 timer 仍需独立检查死亡、睡眠和暴力发射状态，避免星碎期间普通攻击与暴力攻击叠加。

<a id="plant-case-bomb"></a>

## 9. 用例：TNT / 爆炸类植物

代码：`src/game/presets/plant/chapter1/tnt.ts`

- `onCreate()` 850ms 后通过 `host.createExplosion({...})` 造成范围伤害。
- 900ms 后 `host.destroySelf()`。
- `hasExploded` 字段进入 Model 快照，防止回滚重演重复爆炸。
- Entity 持有播种 PRNG 对象，加入 `PLANT_PRNG_FIELDS` 后其状态可回滚。

类似的一次性植物应把“是否已经触发”写成 Model 字段，而不是依赖 Sprite 状态或 Tween 是否播放过。

<a id="plant-special-interactions"></a>

## 10. 特殊交互清单

| 交互 | 处理位置 | 说明 |
| --- | --- | --- |
| 夜间睡眠 | `PlantEntity.setSleeping()` → `PlantModel.onSleepStateChange()` | 夜间植物白天开局睡眠；timer 回调必须检查 `isSleeping` |
| 承载物（睡莲 / 小船） | `PlantHelper.isCarrier()` | 影响同格种植、僵尸目标切换、铲除优先级 |
| 护盾植物 | `SHIELD_PLANT` | 影响僵尸目标切换与玩家铲除优先级 |
| 黑曜石护盾值 | `PlantModel.shieldHealth` | 写在 Model；Entity 只 `declare` 该字段并在 `syncViewFromModel()` 里切帧，不得用 `shieldHealthMax` 等自有字段遮蔽 |
| 魔法粉 | `magicPowderPid` | 僵尸 / 子弹无条件改目标 |
| 星碎大招 | `onStarShards()` | 用 `inBruteShoot` 或等价字段防重入，状态进快照 |
| 冻结 / 减速 debuff | `host.applyDebuffTo()` | debuff 时长与效果进入对应状态 |
| 阳光 / 能量 | `ResourceCmd` | 不直接改 ResourceManager 字段 |

## 11. 检查清单

- [ ] Model 定义所有数值和运行时状态。
- [ ] Entity 只做 `buildView()` 与表现方法；重名的 Model 字段一律 `declare`。
- [ ] 攻击 timer 在触发前检查死亡、睡眠、暴力发射、目标。
- [ ] 延迟发射前再次确认植物存活。
- [ ] 同格优先级使用 `PlantHelper.IsMorePriorityPlant()`，不要重复实现规则。
- [ ] 一次性效果有 `hasExploded` / `hasTriggered` 等快照字段。
- [ ] 稳定 key 使用 `plant:${col}:${row}:${pid}`。
- [ ] PRNG 对象加入 `PLANT_PRNG_FIELDS`。
