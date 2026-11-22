# Entity：物理绑定与单向渲染

<a id="entity-role"></a>

> 适用代码：`src/game/models/core/BaseEntity.ts`、`CombatEntity.ts`、`entities/**`、`projectiles/**`
>
> 相关阅读：[Model 能力边界](./1_model.md#model-boundary)、[回滚与同步](./3_rollback_and_sync.md#rollback-overview)、[Manager 与固定步长循环](../kit/1_manager.md#3-固定步长主循环)

## 1. 一句话原则

**Entity 只绑定物理和单向渲染：把 Model 的状态搬到视图与刚体，不参与战斗决策。**

“单向”指数据流方向固定：

```text
Model 状态 → Entity 访问器 → 视图/刚体
Entity 输入（碰撞、点击） → Model 方法 / Cmd → Model 状态变化
```

Entity 不应从 Sprite、Rapier 或 Tween 中读取状态再写回 Model。物理位置是例外：`BaseEntity.captureSnapshot()` 会优先从 rigidBody translation 采集位置，因为 Rapier 是位置的权威来源；但这属于快照采集，不是业务逻辑。

<a id="entity-boundary"></a>

## 2. 能力边界

Entity 可以做：

- 构建 `viewGroup`、Sprite、Text、粒子挂点。
- 创建 / 销毁 Rapier 刚体与 Sensor，处理碰撞回调转发。
- 播放动画、Tween、音效（通过 SoundCmd / SfxCmd）。
- 暴露稳定的 `SnapshotId`、`col/row`、PRNG 对象、关系引用。
- 调用 `model.onCreate(this)`、`model.onModelStep(this)` 等生命周期钩子。
- 把状态变化请求交给 Model 或 Cmd。
- 通过 `syncViewFromModel()` 按 Model 状态刷新装备/动画/视图。

Entity 不可以做：

- 持有 `tickmanager` 或注册技能 timer。
- 决定伤害、目标选择、技能触发条件、随机数序列。
- 保存确定性数值字段（应该写在 Model）。
- 直接在 `scene.time.delayedCall()` / Tween `onComplete` 中执行逻辑。
- 定义装备数值、护甲血量、武器 key、伤害阈值；这些都属于 [Model 装备能力](./1_model.md#model-equipment)。

<a id="entity-equipment"></a>

### 装备渲染

`EquippedMonsterEntity` 组合了 `withHelmetEntity / withShieldEntity / withWeaponEntity`，是带装备怪物的 Entity 基类。

Entity 侧只允许做：

- `attachHelmetView(def)` / `attachShieldView(def)` / `attachWeaponView(def)`：创建 sprite 或 handObject。
- `syncHelmetView()` / `syncShieldView()` / `syncWeaponView()`：根据 Model 字段切 frame、隐藏破碎装备、开始/停止挥动 Tween。
- `syncViewFromModel()`：汇总刷新；`BaseEntity.restoreSnapshot()` 在回滚末尾调用它。

伤害路由统一在 `EquippedMonsterEntity.takeDamage()`：先问 Model 的盾牌，再问 Model 的护甲，最后才走普通血量扣减。Entity 不定义 `createArmor()`、不保存 `armorConfig`、不持有 `attackTween`。

Compare:

| 需求 | Model | Entity |
| --- | --- | --- |
| 每 1000ms 检查是否有目标并发射 | 持有 timer，判断目标，决定伤害 | 播放射击动画、发射后坐力 |
| 被击中后进入破损阶段 | 改 `currentStage` / 血量 | `switchBodyFrame()` |
| 僵尸碰撞到植物 | 运行 `onCollision()` / `tryStartAttack()` | 把碰撞对象交给 Model |
| 回滚到旧帧 | 恢复字段与 timer | 恢复位置、刚体、视图引用 |

<a id="entity-bridge"></a>

## 3. Entity 与 Model 的桥接

`BaseEntity` 构造时：

1. 用 `cloneLogicModel(model)` 创建实体专属 Model 副本。
2. `model.setTickOwnerId(snapshotKey)` 设置定时器 owner。
3. `model.attachHost(this)` 绑定宿主。
4. `attachModelAccessors(this, this.model)` 安装字段访问器。

```ts
this.model = model ? cloneLogicModel(model) : null;
if (this.model) {
  this.model.setTickOwnerId(this.snapshotKeyId);
  this.model.attachHost(this);
  attachModelAccessors(this, this.model);
  this.modelBound = true;
}
```

`attachModelAccessors()` 只给 Entity 安装访问器，存储仍在 Model：

```ts
Object.defineProperty(entity, key, {
  enumerable: false,
  get: () => source[key],
  set: value => { source[key] = value; },
});
```

### 必须使用 declare

如果 Entity 子类写 `public speed = 0`，类字段会变成自有属性，遮蔽 Model 访问器。正确写法：

```ts
export class SomeEntity extends BaseMonsterEntity {
  declare public speed: number;
  declare public isFrozen: boolean;
}
```

这条规则同样适用于 `health`、`isDying`、`damageThresholds`、`lastSkill`、`hasStick`，以及装备 mixin 定义的 `helmetHealth / helmetBroken / shieldHealth / shieldBroken / weaponKey / weaponVisible / weaponSwinging`。

<a id="entity-lifecycle"></a>

## 4. 生命周期

典型 Entity 初始化顺序：

```text
constructor
  └─ 计算视图坐标 / 阵营 / 物理尺寸
initializeEntity()
  ├─ adoptStableSnapshotKey(...)       // 植物 / 投射物使用稳定 key
  ├─ buildView()
  ├─ buildPhysics()
  ├─ Manager.Register...()
  └─ model.onCreate(this)
```

运行期：

```text
CombatManager 固定步长
  ├─ updateAllTickManagers(...)        // 驱动 Model 的 timer
  ├─ rapierWorld.step()
  ├─ collision event → Game.handleCollision → Entity.onCollision
  └─ BaseEntity.stepUpdate()
       └─ model.onModelStep(this)
```

销毁：

```text
Entity.destroy()
  ├─ model.onModelDestroy(this)
  └─ DeferredManager.defer(() => {
       ├─ 移除 rigidBody
       ├─ viewGroup.destroy()
       └─ model.disposeTickManager()
     })
```

不要在 Entity 的 `destroy()` 中直接移除会被其他实体引用的关系对象；让 Model 与关系快照处理。

<a id="entity-physics"></a>

## 5. 物理绑定规则

不同实体的刚体类型不同：

| 实体 | 刚体 | 说明 |
| --- | --- | --- |
| `PlantEntity` | dynamic + sensor | 作为触发区域，不阻挡移动 |
| `MonsterEntity` | kinematicVelocityBased + sensor | 允许 KINEMATIC_KINEMATIC 碰撞 |
| `ProjectileEntity` | kinematicVelocityBased + sensor | 按速度或固定区域检测 |
| `ObstacleEntity` | dynamic + sensor | 支持双格占位（矿岩） |

Entity 负责把 velocity、translation、sensor size 等物理参数设置好；是否移动、何时销毁由 Model 决定。

碰撞回调只做两件事：

1. 过滤明显无效的目标（同阵营、已命中、飞行/虚空规则等）。
2. 调用 Model 方法或 Cmd。

<a id="entity-render"></a>

## 6. 单向渲染规则

视图方法应该只接受“播放什么”，不接受“是否应该播放”的判断结果之外的业务参数。

推荐：

```ts
public playWardenDig(): void {
  this.getLegacyController()?.raw.dig?.();
}

public applyWardenReposition(row: number, col: number): void {
  const bodyPos = PositionManager.Instance.getZombieBodyCenter(col, row);
  const viewPos = PositionManager.Instance.getZombieBottomCenter(col, row);
  this.col = col;
  this.row = row;
  this.rigidBody?.setTranslation(bodyPos, true);
  this.animController.updatePosition(viewPos.x + this.offsetX, viewPos.y + this.offsetY);
  this.getLegacyController()?.raw.getOut?.();
}
```

不推荐：

```ts
// 反例：Entity 自己决定触发概率、伤害、召唤数量
private rollSkill(): void {
  if (Math.random() < 0.3) { /* ... */ }
}
```

一次性表现事件通过 `logicEvents.emit()` 发送到渲染层消费，eventId 去重，避免回滚重演时重复播放音效。

<a id="entity-rollback"></a>

## 7. Entity 如何参与回滚

`BaseEntity.captureSnapshot()` 保存的是**胶水层状态**：

```ts
{
  kind: "entity",
  id: SnapshotId,
  col, row,
  x, y,                         // rigidBody translation 优先
  hp, maxHp, speed,
  flags: {
    ...关系字段,                  // attacking / underAttackBy / summoner 等
    ...PRNG,                     // seedrandom 对象状态
    ...captureLogicState(),      // mid/pid/waveID/spawnSeq/level 等
    model: snapshotModel(model), // Model 字段
  },
  timers: model.captureTimers(),
  extra: { rigidBodyHandle, ... },
}
```

恢复时：

```text
关系字段 → PRNG → 子类 restoreLogicState() → Model timers
→ Model 字段 → hp/maxHp/speed → 位置 / 刚体
```

Entity 自身不保存可独立序列化的业务状态。若需要在快照中记录实体身份，使用 `SnapshotId` / `adoptStableSnapshotKey()`；实体不持有进入快照的 TimerKey，也不按 group 过滤全局 timer。

需要注意一个例外：`entity.attackTimer` 句柄只用于本机停止普攻循环，**不进快照**，重连后为 `null`。因此 `MonsterModel.beginAttackTimer()` / `clearAttackTimer()` 必须额外调用 `tickmanager.removeByEvent("MonsterAttack")` 兜底，保证任何时刻只有一条普攻循环；换目标时 `retargetAttack()` 只换关系不重建定时器。

刚体句柄通过 `PhysicsSnapshot` 记录。rebuild 模式下 Rapier world 被替换，再按稳定 handle 找回刚体并补回 `userData`。

关系字段在 `LogicRelations.ts` 中声明，例如：

```ts
OBSTACLE_RELATION_FIELDS = ["summoner", "underAttackBy"];
MONSTER_RELATION_FIELDS = ["attacking", "underAttackBy", ...];
```

它们通过 `EntityLookup` 把 `entity:<SnapshotId>` 解析回当前存活实体。

## 8. 常用实体基类

| 基类 | 适用 | 能力 |
| --- | --- | --- |
| `BaseMonsterEntity` / `EquippedMonsterEntity` | 地面僵尸 | 装备视图 + 伤害路由 |
| `MediumMonsterEntity` / `BaseZombieEntity` | 普通/装甲僵尸 | `baseAttackDamage + weaponDamage`、坐骑挂点 |
| `FlyingMonsterEntity` | 气球僵尸 / 气球TNT分身 | 载具血条、bullet 吸收、laser/explosion 穿透、落地补判 |
| `DivingZombieEntity` | 潜水僵尸 | 潜行/探出姿态、波纹、面罩挂点 |
| `DolphinRiderEntity` | 海豚骑乘僵尸 | 海豚坐骑图层、坐姿、破碎后速度回退 |

这些基类只提供“怎么表现”，技能阶段和伤害决策仍在各自的 Model 中。

## 9. 新增 Entity 的检查清单

1. 确定性字段只在 Model 定义，Entity 用 `declare`。
2. 构造函数只准备视图/物理参数，不执行技能决策。
3. `initializeEntity()` 末尾调用 `model.onCreate(this)`。
4. 视图方法命名成 `playXxx()` / `applyXxx()`，避免承载业务判断。
5. 碰撞回调只过滤并转发；“接触即触发”用 `onCollision` + 状态切换瞬间一次性补判，不要回到每帧 `stepUpdate` 轮询。
6. Tween `onUpdate/onComplete`、`scene.time.delayedCall()`、动画完成回调里禁止写 `col/row/x/y`、刚体平移、血量、Cmd 或技能阶段；权威坐标在 tick 事件里一次写入。
7. 需要延迟逻辑时用 Model 的 `tickmanager.schedule()`，不要用 `scene.time`。
8. 需要稳定恢复的对象使用 `adoptStableSnapshotKey()`。
9. PRNG 对象若参与确定性，加入对应 `*_PRNG_FIELDS`。
10. 实体持有的 timer 句柄（如 `attackTimer`）不进快照，停止时必须按事件名兜底清理。
