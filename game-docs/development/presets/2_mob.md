# 僵尸 Preset 开发指南

<a id="mob-overview"></a>

> 适用代码：`src/game/models/MonsterModel.ts`、`src/game/models/entities/MonsterEntity.ts`、`src/game/presets/monster/**`、`src/game/core/logic/TickEvents.ts`
>
> 相关阅读：[Model 能力边界](../models/1_model.md#model-boundary)、[Entity 能力边界](../models/2_entity.md#entity-boundary)、[植物同格优先级](./1_plant.md#plant-priority)、[回滚与同步](../models/3_rollback_and_sync.md#rollback-overview)

## 1. 文件组织

每个怪物 preset 通常包含：

```text
XxxModel extends PresetMonsterModel（或更具体 Model）
XxxEntity extends BaseMonsterEntity（或其子类）
export const XxxData = new XxxModel({ mid, weight, maxHealth, ... })
```

`XxxData` 是模板；每个场上的怪物由 `BaseEntity` 克隆出独立 Model。怪物实体由 `MobCmd.Spawn()` 创建，`MobManager` 分配 `spawnSeq` 与稳定快照 key。

<a id="mob-lifecycle"></a>

## 2. 生命周期

```text
MobManager 波次定时器到点
  → MobCmd.Spawn(mid, scene, col, row, waveID)
  → DeferredManager.defer
  → MonsterLibrary.GetModel(mid).createEntity(...)
  → MonsterEntity 构造
      ├─ 坐标 / 阵营 / 物理尺寸
      └─ MonsterModel.applySpawnSeed(spawnSeq)
  → initializeEntity()
      ├─ buildView() / animController
      ├─ buildPhysics()（kinematic + sensor）
      ├─ playSpawnAudio()
      ├─ startMove()
      └─ model.onCreate(this)
```

`mid / waveID / spawnSeq` 通过 `captureLogicState()` 进入快照，用于 rebuild。出生偏移由播种随机器计算，不使用 `Math.random()`。

<a id="mob-model"></a>

## 3. Model 写法

`MonsterModel` 已经承载通用战斗决策：

- 出生偏移、越界判负。
- 目标选择、转移目标、停攻、普攻命中。
- 受伤、死亡、星碎掉落。
- 破损阶段、护甲减伤。
- 技能 timer 与 `handleTickEvent()` 分派。

新怪物只需要在特化 Model 中写：

1. 新增运行时状态字段。
2. `tickEventNames` 新增事件。
3. `onCreate()` 注册初始 timer。
4. `handleTickEvent()` 分派技能事件。
5. `skill1/skill2` 等技能决策。

骨骼：

```ts
export class MyMonsterModel extends PresetMonsterModel {
  public override readonly tickEventNames = [
    ...DEFAULT_TICK_EVENT_NAMES,
    TickEventNameEnums.MySkill,
  ];

  public override onCreate(entity: MonsterEntity): void {
    this.tickmanager.schedule(TickEventNameEnums.MySkill, 3000, { repeat: 2 });
  }

  public override handleTickEvent(eventName, args = null, timerId?): void {
    if (eventName === TickEventNameEnums.MySkill) {
      const entity = this.host as MyMonsterEntity | null;
      if (!entity || entity.currentHealth <= 0) return;
      entity.playMySkillAnim();
      MobCmd.DamagePlantsArea(entity.col, entity.row, 1, 1, 100);
      return;
    }
    super.handleTickEvent(eventName, args, timerId);
  }
}
```

事件参数用 JSON 安全对象，例如 `{ col, row, delay }`。

<a id="mob-entity"></a>

## 4. Entity 写法

Entity 负责：

- `createAnimController()`。
- `buildView()`、挂件同步、动画播放。
- 物理尺寸 / Sensor。
- 提供视图能力方法，如 `playWardenDig()`、`startArcReposition()`、`playSkillSfx()`。

Entity 不再持有 `tickmanager`，也不决定何时攻击、召唤或重定位。

```ts
export class MyMonsterEntity extends BaseMonsterEntity {
  declare public model: MyMonsterModel;

  protected createAnimController() {
    return createZombieAnimController("my_monster", this.scene, this.x, this.y);
  }

  public playMySkillAnim(): void {
    this.getLegacyController()?.raw.startArmSwing?.();
  }
}
```

如果 Entity 子类声明 Model 已定义的字段，必须使用 `declare`，否则会遮蔽访问器。

<a id="mob-target-switch"></a>

## 5. 僵尸转移目标机制

这是怪物最重要的一类交互，完整链路如下。

### 5.1 初始选目标

```text
Rapier collision
  → Game.handleCollision
  → MonsterEntity.onCollision(ctx)
  → MonsterModel.onCollision(entity, ctx)
  → MonsterModel.tryStartAttack(entity, target)
```

`tryStartAttack()` 的过滤顺序：

1. 冻结或已锁定同一目标 → 不处理。
2. 目标是飞行怪且自己不会飞 → 不处理。
3. 目标在虚空 → 不处理。
4. 当前目标与新目标都是植物，且 `IsMorePriorityPlant(current, target)` 为真 → 先 `stopAttacking()`。
5. 设置 `attacking = target`、`isStop = true`、停移动、加入目标 `underAttackBy`、播放攻击动画。
6. `beginAttackTimer()` 启动 `MonsterAttack` 循环 timer。

<a id="mob-attack-timer"></a>

### 5.2 攻击 timer

`MonsterModel.beginAttackTimer()` 注册：

```ts
this.tickmanager.schedule(TickEventNameEnums.MonsterAttack, intervalMs, { loop: true });
```

到点后由 `MonsterModel.handleTickEvent()` 调用 `hurtTarget()`：

- 目标为空或血量 ≤ 0 → `stopAttacking()`。
- 否则造成 `attackDamage`，如果目标死亡再 `stopAttacking()`。

timer 存在 Model 中，回滚时随 Model 恢复；暂停时随固定步长循环停止。

### 5.3 转移 / 停止条件

| 条件 | 处理 |
| --- | --- |
| 碰撞到更高优先级植物 | `tryStartAttack()` 先 `stopAttacking()`，再锁定新目标 |
| 当前目标死亡 | `PlantEntity.destroy()` 通知 `underAttackBy` 中的僵尸 `stopAttacking()` |
| 僵尸受击 / 冰冻 | `isFrozen` 阻止新攻击；已有 timer 仍由 Model 决定如何处理 |
| 僵尸死亡 | `zombieDie()` → `stopAttacking()` → 播放死亡动画 |
| 撑杆跳僵尸起跳 | `StickZombieModel.tryStartVault()` 改写飞行/速度，落点有植物才 `tryStartAttack()` |

`stopAttacking()` 必须成对维护：

```text
旧目标.underAttackBy.delete(entity)
attacking = null
停止手臂动画
移除 attackTimer
isStop = false
startMove()
```

漏掉任何一步都会造成目标残留、幽灵攻击或停止移动。

<a id="mob-event-timers"></a>

## 6. 事件驱动技能定时器

所有技能 timer 走 `TickEventNameEnums`，例如：

```text
EvokerSummon / EvokerResume
GolemBegin → GolemCast → GolemArmStop → GolemReposition → GolemSummonNext
WardenLand / WardenReposition
ObsidianColumn / ObsidianObstacleSpawn / ObsidianReposition
CentipedeSpawn / CentipedeCycle / CentipedeDisappear / ...
```

不要在 Entity 中写：

```ts
this.scene.time.delayedCall(1000, () => this.skill());
```

而应在 Model 中写：

```ts
this.tickmanager.schedule(TickEventNameEnums.WardenLand, 1000);
```

Entity 只提供 `playWardenLand()` 等表现入口。

<a id="mob-case-basic"></a>

## 7. 用例：普通僵尸 / 装甲僵尸

代码：`src/game/presets/monster/zombie/zombie.ts`、`cap_zombie.ts`、`helmet_zombie.ts`、`turtle_zombie.ts`。

- 普通僵尸：`ZombieData` mid=1，HP300，weight 随波次衰减。Entity 只提供基础僵尸动画。
- 帽子/钢盔/龟甲僵尸：Model 用 `withHelmetModel` 定义 `EquipmentDef` 与破碎钩子；Entity 用 `EquippedMonsterEntity` + `withHelmetEntity` 只渲染 sprite。旧的 `BaseZombieArmorEntity.createArmor()` 与 `MonsterModel.applyArmorDamage()` 已删除。
- `damageThresholds` 写在 `MonsterDefinition.damageThresholds`，由 `PresetMonsterModel` 构造时写入 Model；Entity 只 `declare` 字段。血量下降时 `updateBodyDamageStage()` 调用动画切换。

新增同类怪物时，通常只需定义 Data、装备 Def 和动画控制器；通用攻击/受伤逻辑已经在 Model。

<a id="mob-case-equipment"></a>

### 装备组合用例

`Equipment.ts` 提供 helmet / shield / weapon 三套 Model + Entity mixin，可自由组合：

| 怪物 | 组合 | 说明 |
| --- | --- | --- |
| miner helmet | helmet + weapon | 钢盔用 `withHelmetModel`，镐子用 `withWeaponModel`；Model 的 `onCreate()` 分别 `equipHelmet()` / `equipWeapon()` |
| vindicator soldier | shield + weapon | 正面子弹判定写在 `canShieldBlock()`；盾破后的整额伤害写在 `shieldBreakOverflow()` |
| turtle skeleton bow | shield + weapon | 龟壳是 shield，弓是 weapon；破碎后连射由 Model timer 调度 |
| mutant | weapon | `attach/sign` 通过 `handObject` 挂到动画控制器；攻击状态驱动武器表现 |

Entity 侧不应再出现 `attackTween`、`swingTween`、`createArmor()` 或装备数值。

<a id="mob-case-stick"></a>

## 8. 用例：撑杆跳僵尸

代码：`src/game/presets/monster/zombie/stick_zombie.ts`。

Model 负责：

- `hasStick` 与 `vaultTargetX` 状态；`attach/hd_stick` 定义在 `STICK_WEAPON` 中，落地时 `consumeWeapon()` 隐藏手杖。
- `canVaultOverPlant()` 决定是否可越过该植物（TNT 矿场也通过此接口查询）。
- `tryStartVault(entity, target)`：只有目标植物且有 col 才起跳。
- `shouldFinishVault(entity)`：`x <= vaultTargetX` 时落地。
- `finishVault(entity)`：落点有植物则 `tryStartAttack()`，否则 `startMove()`。

Entity 负责：

- `withWeaponEntity` 创建手杖挂点并按 `weaponVisible` 显示/隐藏。
- `updateView()` 中根据 `isFlying` 调整动画 y 偏移。
- `canVaultOverPlant()` 只转发给 Model，不做判断。

特殊交互：碰撞阶段要先让 Model 记录落点植物，避免落地后目标已丢失。

<a id="mob-case-evoker"></a>

## 9. 用例：Evoker 召唤

代码：`src/game/presets/monster/zombie/evoker.ts`。

- `onCreate()` 排 `EvokerSummon`：`startAt=24000, delay=28000, repeat=3`。
- 到点后停攻停走、切召唤动画，在四个相邻格 `MobCmd.Spawn(VindicatorData.mid, ...)`。
- 再排 `EvokerResume`，恢复手臂动画和移动。
- Entity 只创建 evoker 动画控制器。

关键：`startAt` 只影响第一次触发，后续按 `delay` 周期执行；事件参数无需携带闭包。

<a id="mob-case-boss"></a>

## 10. 用例：Boss 状态机

### Golem

`GolemModel` 维护 `pendingSpawns`、`callCount` 与技能阶段：

```text
GolemBegin
  → runCycle() 排 GolemCast(skill)
  → callMob() 用 generateBossWaveScript + pendingSpawns 分批召唤
GolemCast
  → 子类 Model.skill1/skill2
  → 3200ms 后 GolemArmStop
GolemArmStop
  → getGolemRecoverDelay() 后 GolemReposition
GolemReposition
  → Entity 视图重定位完成 → runCycle()
```

Warden / ObsidianGolem 通过扩展 Model 覆写 `skill1/skill2` 和新增事件实现差异化，Entity 只播放 `highJump / land / dig / getOut`。

### Centipede

`CentipedeModel` 维护血量触发与四套技能：

- `checkHealthTriggers()`：0.8 / 0.6 / 0.4 / 0.2 触发技能 0，0.5 闪屏与 hooks。
- `pickSkill()` 排除上次技能，用 `MobCmd.DeterministicRandom()` 选 1/2/3。
- 技能 0：落石障碍 + 秒杀半血植物。
- 技能 1：冲锋后按格子伤害植物与侧行。
- 技能 2：三行召唤幼虫，Sfx 后 450ms 实际 `MobCmd.Spawn()`。
- 技能 3：两处爆炸范围伤害。
- 重定位后继续周期。

所有延迟都通过 Model timer；Entity 的 `startArcReposition()` 只在动画回调里通知 Model 完成。

<a id="mob-special"></a>

## 11. 特殊交互清单

| 交互 | 处理位置 | 说明 |
| --- | --- | --- |
| 目标优先级 | `PlantHelper.IsMorePriorityPlant()` | 见 [植物优先级](./1_plant.md#plant-priority) |
| 目标死亡 | `PlantEntity.destroy()` → `underAttackBy` | 自动让攻击者停攻 |
| 星碎掉落 | `MonsterModel.dropCarriedStarShards()` | `starShardsDropped` 进快照防重复 |
| 护甲 / 盾牌 / 武器 | `Equipment.ts` 的 helmet / shield / weapon mixin | Model 定义数值与破碎规则；Entity 只渲染 |
| 装备回滚 | Model 字段 + `syncViewFromModel()` | 恢复 sprite 可见性、frame、挥动状态 |
| Boss PRNG | Entity PRNG + `MONSTER_PRNG_FIELDS` | 先播种再快照 |
| Boss 召唤 | `generateBossWaveScript` + `pendingSpawns` | 状态进 Model 快照 |

## 12. 检查清单

- [ ] 数值、装备配置和技能决策在 Model。
- [ ] Entity 只暴露动画/视图能力，不持有 `attackTween` / `createArmor`。
- [ ] 装备状态用 helmet / shield / weapon mixin，破损与溢出伤害由 Model 决定。
- [ ] 攻击 timer 是 `MonsterAttack`，不是 Entity 闭包。
- [ ] 转移目标走 `MonsterModel.tryStartAttack()`。
- [ ] 停攻时清理 `underAttackBy`、`attackTimer`、`isStop`。
- [ ] 新增技能事件加入 `tickEventNames`。
- [ ] Boss 的随机源和召唤队列可回滚。
- [ ] 需要在 rebuild 中识别的实体有稳定 key。
