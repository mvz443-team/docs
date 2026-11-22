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
- 攻击时序：一律用 `this.tickmanager.schedule(eventName, ms, args)`，事件名定义在 preset 本地常量并加入 `tickEventNames`。**不要**用 `addEvent({ callback })` 承载需要跨端/跨进程恢复的技能逻辑——`callback:N` 是进程内注册表句柄，重连后含义不同。
- 目标判定：读取 SightLine 查询结果，决定是否攻击。
- 星碎逻辑：`onStarShards()`。
- 受击 / 死亡逻辑：`onHurt()` / `onDeath()`。

骨骼（事件名驱动，参数 JSON 安全）：

```ts
const MY_PLANT_EVENTS = {
  Shoot: "MyPlantShoot",
  Fire: "MyPlantFire",
} as const;

export class MyPlantModel extends PlantModel {
  public override readonly tickEventNames: readonly string[] = [
    ...DEFAULT_TICK_EVENT_NAMES,
    MY_PLANT_EVENTS.Shoot,
    MY_PLANT_EVENTS.Fire,
  ];

  public override pid = 999;
  public override nameKey = "name_my_plant";
  public override descriptionKey = "my_plant_description";
  public override texturePath = "plant/my_plant";

  // 静态数值 sealPlantConfig() 后迁入非枚举 config，不进快照
  public maxHealth = new LevelScaledValue(300);
  public cost = new LevelScaledValue(100);
  public cooldown = new LevelScaledValue(5000);
  public cooldownStartAtRatio = 0;
  public damage = new LevelScaledValue(20);
  public isNightPlant = false;

  // 运行时状态：进快照
  public inBruteShoot = false;

  public override createEntity(scene, col, row, level): MyPlantEntity {
    return this.initializeEntity(new MyPlantEntity(scene, col, row, level));
  }

  public override onCreate(entity: MyPlantEntity): void {
    entity.setSightLine(/* ... */);
    this.tickmanager.schedule(MY_PLANT_EVENTS.Shoot, 800, { repeat: -1, interval: 1000 });
  }

  public override handleTickEvent(eventName, args = null, timerId?): void {
    const entity = this.host as MyPlantEntity | null;
    if (!entity) return;
    if (eventName === MY_PLANT_EVENTS.Shoot) {
      if (entity.isSleeping || this.inBruteShoot || !entity.hasSightTarget()) return;
      entity.playShootAnimation();
      this.tickmanager.schedule(MY_PLANT_EVENTS.Fire, 200);
      return;
    }
    if (eventName === MY_PLANT_EVENTS.Fire) {
      if (entity.currentHealth > 0) this.shoot(entity);
      return;
    }
    super.handleTickEvent(eventName, args, timerId);
  }

  private shoot(entity: MyPlantEntity): void {
    ProjectileCmd.Create(ArrowModel, entity.scene, entity.x, entity.row, {
      damage: this.damage.getValueAt(entity.level),
      faction: Faction.PLANT,
      speed: 900,
    });
  }
}
```

详见 [Model 定时器](../models/1_model.md#model-tick) 与 [Model 静态配置](../models/1_model.md#model-state)。

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
tick 到点（事件名来自 tickEventNames）
  ├─ 植物是否死亡 / currentHealth <= 0
  ├─ 是否睡眠 isSleeping
  ├─ 是否处于暴力发射 inBruteShoot
  ├─ SightLine.hasTarget()
  ├─ playShootAnimation()
  └─ tickmanager.schedule(Fire, 约 200ms)
       └─ Fire 事件里再次确认存活 → ProjectileCmd.Create(...)
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

### 6.1 僵尸普攻目标选择（不要折叠数组）

僵尸啃食目标必须使用 `MonsterModel.attackTargetRank(pid)` 的**显式全序**：

| rank | 植物类型 |
| --- | --- |
| 0 | 护盾植物（pid 19 南瓜护照） |
| 1 | 粉尘植物（魔术粉 / 萤石粉） |
| 2 | 普通植物 |
| 3 | 承载物（睡莲 / 小船） |

`pickBestCandidate()` 先按 rank 升序，同级按 `pid`、再按 `SnapshotId` 字符串升序兜底。这样候选结果与 `PlantsMap` 数组插入顺序完全无关。

**不要**再用 `PlantHelper.IsMorePriorityPlant` 折叠 `PlantsMap` 数组选目标：粉尘与护盾互相“高于”对方，该关系非传递，折叠结果会随插入顺序变化；重连按快照 id 重建实体后数组顺序与连续运行不同，必然导致 desync。该函数目前只用于“新碰撞目标是否顶掉当前目标”等局部判断。

调用链：

```text
Rapier collision
  → Game.handleCollision
  → MonsterEntity.onCollision
  → MonsterModel.onCollision
  → MonsterModel.tryStartAttack
      ├─ canStartAttack()（体态/冻结/阵营过滤）
      ├─ pickBestCandidate()（attackTargetRank 全序）
      └─ attacking = target + 关系集合更新
```

目标死亡接力由 Model 完成：`PlantEntity.destroy()` 通知 `underAttackBy` → `MonsterEntity.onAttackTargetDestroyed()` → `MonsterModel.onAttackTargetDestroyed()` → `pickContactTarget()` 扫死亡目标格与自身当前格 → `retargetAttack()` **只换目标不重建攻击定时器**。普攻循环 `MonsterAttack` 由 `beginAttackTimer()` / `clearAttackTimer()` 按事件名 `removeByEvent()` 兜底清理，保证任何时刻只有一条循环。`stopAttacking()` 仍需成对维护旧目标关系、`attacking = null`、停手动画、`isStop = false` 和 `startMove()`。

### 6.2 子弹穿透同格植物

`BulletEntity.onCollision()` 命中植物后：

```text
ProjectileModel.canHit(plant) 过滤体态（tiny/flying/inVoid）
  → PlantHelper.GetPlantsInGrid(col,row)
  → applyEffect(current)
  → 穿透次数判定
  → 在同格中找 IsMorePriorityPlant(candidate, current) 的植物
  → 继续命中更高优先级目标
```

子弹同格穿透仍用 `IsMorePriorityPlant`（这与僵尸普攻的 `attackTargetRank` 是两条不同链路），但候选必须先经过 `ProjectileModel.canHit()` 的体态过滤——`hitKind` 为 `laser/explosion` 的攻击可命中更低矮或更高层的目标，普通 bullet 不行。这保证“先打承载物、后打上面植物”或“护盾优先”的行为在子弹穿透时同样成立，且不会因为体态规则造成穿透到不该打的目标。

### 6.3 铲除 / 星碎选择（所见即所得）

规则集中在零依赖纯函数 `src/game/utils/helper/PlantTargeting.ts`，调用顺序固定为 `carrier`（睡莲/船）→ `inner`（内部植物）→ `shield`（护盾植物 pid 19）。

星之碎片：`PlantHelper.GetStarShardsTarget(plants, aspect)`，`aspect` 由鼠标在格子内的上下半区产生（`up` / `down`）：

| 场景 | 规则 |
| --- | --- |
| 同格有护盾 + 内部植物 | `down` → 护盾外壳；`up` → 内部植物 |
| 只有内部植物 / 只有护盾 | 直接选中 |
| 只剩承载物 | 承载物兜底 |

铲除：`PlantHelper.GetRemovePlantTarget()` → `GetHighestPriorityPlant(plants, pointer)`，同样是 `down` 先铲护盾、`up` 先铲内部植物；两株且有承载物时优先非承载物。`SHIELD_PLANT_PIDS = [19]`，但护盾角色的唯一真相是 `plant.stackRole === 'shield'`，pid 表只作回落兼容。

**强制约束**：`CursorManager.updateStarShardsHighlight()`（预览）与 `PlantsManager.handleAttemptUseStarShards()`（执行）必须调用同一个 `PlantHelper.GetStarShardsTarget`，否则会出现“高亮 A、实际给 B”。

种植侧规则在 `PlantHelper.CanPlantInGrid()`，校验顺序：

1. 无 Model 保守拒绝；
2. 地块白名单 `allowedPlantSlots`（`ground/water/sky`，`null` = 不限）；
3. 基座关系 `requiredBasePid`（`11 → 9` 阴森南瓜头、`14 → 1` 发射器），命中则短路后续规则；
4. `placementRule` / `stackRole` 的同格冲突（`overlayAny` / `overlayExisting` / carrier / shield / normal）；
5. 水格收口：水本生直接种、`overlayExisting` 优先于承载物，否则必须有 carrier。

一次性植物由 `isOneTimePlant` + `applyInstantEffect()` 在同一确定性帧结算，不创建 Entity / 物理体。高级植物替换基座统一走 `PlantHelper.CreateEntityWithBaseReplacement()`：先创建新植物再销毁 `requiredBasePid` 指定的那一株，并继承基座 `isSleeping` 状态（通过 `PlantCmd.SetSleeping` 延迟应用）；同格睡莲/护盾等其他植物不受影响。preset 的 `createEntity` 不再各自处理基座。

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
| 承载物（睡莲 / 小船） | `PlantHelper.isCarrier()` / `stackRole='carrier'` | 影响同格种植、僵尸目标切换、铲除优先级 |
| 护盾植物 pid 19 | `stackRole='shield'`、`PlantTargeting.SHIELD_PLANT_PIDS` | 同格内部植物由 `PlantModel.redirectDamageToShield()` 转发伤害；僵尸普攻 rank 0；AoE 逐株直伤不吸收 |
| 气球TNT pid 20 | `tiny` 充气三态 | 充满后 `tiny=false`，只被飞行怪引爆；星碎召唤 mid 21 PLANT 阵营分身 |
| 黑曜石护盾值 | `PlantModel.shieldHealth` | 写在 Model；Entity 只 `declare` 该字段并在 `syncViewFromModel()` 里切帧，不得用 `shieldHealthMax` 等自有字段遮蔽 |
| 魔法粉 / 萤石粉 | `magicPowderPid`、`placementRule='overlayAny/overlayExisting'`、`isOneTimePlant` | 同格粉尘植物；僵尸普攻 rank 1；一次性效果不创建 Entity |
| 星碎大招 | `onStarShards()` | 用 `inBruteShoot` 或等价字段防重入，状态进快照；目标选择走 `GetStarShardsTarget` |
| 冻结 / 减速 debuff | `host.applyDebuffTo()` → `CombatEntity.addDebuff()` | 时长与效果进 Model 的到期帧字段；Entity 不做免疫判断 |
| 阳光 / 能量 | `ResourceCmd` | 不直接改 ResourceManager 字段 |
| 接触即触发 | `onCollision` + 一次性补判 | 气球TNT/TNT 地雷删除每帧轮询；状态切换瞬间可能已重叠，用 `checkAirborneCollisionOnce` / `checkContactOnce` 补判一次 |

## 11. 检查清单

- [ ] Model 定义所有数值和运行时状态。
- [ ] Entity 只做 `buildView()` 与表现方法；重名的 Model 字段一律 `declare`。
- [ ] 攻击 timer 在触发前检查死亡、睡眠、暴力发射、目标；事件名加入 `tickEventNames`，不用 `addEvent({ callback })`。
- [ ] 延迟发射用事件名再次确认存活后再生成投射物。
- [ ] 僵尸普攻目标用 `attackTargetRank` 全序；子弹穿透才用 `IsMorePriorityPlant` + `canHit` 体态过滤。
- [ ] 星碎/铲除目标用 `PlantTargeting`，预览与执行共用同一入口。
- [ ] 静态数值/`EquipmentDef` 封进非枚举 config，不进快照；运行时状态进快照。
- [ ] 一次性效果有 `hasExploded` / `hasTriggered` 等快照字段。
- [ ] 稳定 key 使用 `plant:${col}:${row}:${pid}`。
- [ ] PRNG 对象加入 `PLANT_PRNG_FIELDS`。
- [ ] “接触即触发”用 `onCollision` + 一次性补判，不回到每帧轮询。
