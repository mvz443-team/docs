# Model：唯一的业务逻辑层

<a id="model-role"></a>

> 适用代码：`src/game/core/logic/LogicModel.ts`、`src/game/models/{MonsterModel,PlantModel,ObstacleModel}.ts`、`src/game/models/projectiles/ProjectileModels.ts`、`src/game/presets/**`
>
> 相关阅读：[Entity 能力边界](./2_entity.md#entity-role)、[回滚与同步](./3_rollback_and_sync.md#rollback-overview)、[Cmd 命令层](../kit/2_cmd.md#cmd-overview)

## 1. 一句话原则

**Model 做所有业务逻辑并定义数值；Entity 只绑定物理和单向渲染。**

具体含义：

| 归属 | Model | Entity |
| --- | --- | --- |
| 血量、速度、冷却、技能阶段 | 定义并修改 | 不保存，只通过访问器读写 |
| 装备数值、破损阈值、武器状态 | 定义在 Model 配置与字段中 | 只渲染，不定义数值 |
| 伤害公式、目标选择、技能分支 | 实现 | 不参与决策 |
| 定时器 | 每个 Model 独立持有 | 不持有 tickmanager |
| 随机数、PRNG 状态 | 调用确定性随机源 | 只保存 PRNG 对象供快照 |
| Phaser / Rapier 依赖 | 禁止 | 允许 |
| 视图动画、粒子、音效 | 通过 `host` 或 Cmd 请求 | 执行 |

如果一段代码回答的是“会发生什么”，它属于 Model；如果回答的是“画面上怎么表现”，它属于 Entity。

<a id="model-boundary"></a>

## 2. 能力边界

`LogicModel` 通过 `ModelHost` 向 Entity 借用世界能力，而不是直接依赖 Phaser/Rapier：

```ts
export interface ModelHost {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly row?: number;
  readonly col?: number;
  readonly faction?: number;
  readonly gridSizeX: number;
  createExplosion(config: Record<string, unknown>, x?: number, y?: number, row?: number): void;
  createProjectile(model: unknown, config: Record<string, unknown>): void;
  applyDebuffTo(target: unknown, name: string, durationMs: number): void;
  applyDamage(target: unknown, amount: number, dealer: unknown, source: unknown): void;
  hasAttacked(target: unknown): boolean;
  markAttacked(target: unknown): void;
  destroySelf(): void;
  /** Model 状态变化后请求 Entity 单向刷新视图；Entity 不反向保存业务状态。 */
  syncViewFromModel?(): void;
  emit(type: string, data?: JsonValue): void;
}
```

Model 可以直接调用这些能力，也可以通过 [Cmd](../kit/2_cmd.md#cmd-overview) 发起世界变更。二者都不是让 Model 保存视图对象。

### Model 不应该做的事

- 不保存 `Phaser.GameObjects.*`、`RAPIER.RigidBody`、`scene.tweens` 等对象引用。
- 不调用 `scene.time.delayedCall()` 驱动逻辑。
- 不把函数、Map、Set、类实例写入会被快照的字段。
- 不直接修改另一个 Entity 的确定性字段；通过 Cmd 或目标 Model 的方法。
- 不在 Model 中调用 `Math.random()`。
- 不在 Model 里只改 Sprite / Tween 状态而不写 Model 字段；回滚会丢失这类“状态”。

<a id="model-equipment"></a>

### 装备能力（helmet / shield / weapon）

装备统一放在 `src/game/models/equipment/Equipment.ts`。三种能力各有 Model 侧接口与 mixin：

| 能力 | Model 接口 / mixin | Model 负责 | Entity 负责 |
| --- | --- | --- | --- |
| helmet | `IHelmetModel` / `withHelmetModel` | 护甲血量、阈值、减伤、破碎钩子 | 创建/隐藏 sprite、切 frame |
| shield | `IShieldModel` / `withShieldModel` | 是否格挡、护盾血量、破碎溢出伤害 | 盾牌 sprite、切 frame |
| weapon | `IWeaponModel` / `withWeaponModel` | 武器是否可见、是否挥动、消耗武器 | 手持挂点、挥动 Tween |

装备定义 `EquipmentDef` 是 JSON 安全的普通对象，包含 `key / maxHealth / thresholds / damageScale / hitSound / visual`。它定义在 Model 侧，可随 Model 快照保存。

典型用法：

```ts
const CAP_HELMET: EquipmentDef = {
  key: "attach/cap",
  maxHealth: 370,
  thresholds: [250, 125],
  hitSound: "leatherHit",
  visual: { attachment: "fixed", depth: 13 },
};

export class CapZombieModel extends withHelmetModel(PresetMonsterModel) {
  public override onCreate(entity: MonsterEntity): void {
    this.equipHelmet(entity, CAP_HELMET);
  }
}
```

`equipHelmet()` / `equipShield()` / `equipWeapon()` 会先把数据写入 Model，再调用 Entity 的 `attachXxxView()` 与 `syncViewFromModel()`。伤害路由在 `EquippedMonsterEntity.takeDamage()` 中固定为：

```text
shield → helmet → 普通 takeDamage
```

破碎时的溢出伤害由 Model 的 `shieldBreakOverflow()` / `onHelmetBroken()` 决定。不要用 Entity 的 `onArmorBroken()` 或 `attackTween` 承载这类决策。

<a id="model-state"></a>

## 3. 状态：写字段即进快照

`LogicModel` 构造器返回 `trackLogicObject(this)` 创建的 Proxy。它会拦截字段写入、删除和数组变更，并记录 Undo Log。因此：

```ts
export class CounterPlantModel extends PlantModel {
  // 运行时状态：JSON 安全，自动进入快照
  public shotsFired = 0;
  public cooldownLeft = 0;
  public hitCells: number[] = [];
}
```

允许的字段类型：

- `number` / `boolean` / `string` / `null`
- 由这些类型组成的数组
- prototype 为 `Object.prototype` 的纯对象

禁止写入的类型：

- 函数
- `Map` / `Set` / class instance
- `PlantStat`、`Phaser.Sprite`、`RAPIER.RigidBody`

类实例配置（如 `PlantStat`、工厂函数）不会进入 `flags.model`，也不要运行时改写。`EquipmentDef` 是 JSON 安全的纯对象，会随 Model 快照保存；这是为了让回滚后仍能知道护盾/武器的配置与当前状态。

### 字段命名注意

Entity 上的兼容访问器由 `attachModelAccessors()` 安装。若 Entity 自己声明了同名字段并初始化，会产生字段遮蔽，导致状态写回 Entity 而不是 Model。解决办法是使用 `declare`：

```ts
export class SomeMonsterEntity extends BaseMonsterEntity {
  declare public speed: number;
  declare public isFrozen: boolean;
}
```

<a id="model-tick"></a>

## 4. 每个 Model 独立持有定时器

`LogicModel` 持有非枚举字段 `tickmanager`，类型是 `ITickManagerProxy`。它不是全局 `TickerManagerProxy`：

```ts
public readonly tickmanager!: ITickManagerProxy;
public readonly tickEventNames!: readonly TickEventNameEnums[];
public readonly host!: ModelHost | null;
```

`EntityTickManager` 的特点：

- timer 只存 `id / eventName / targetFrame / repeat / interval / group / args` 纯数据。
- 回调按函数身份注册到稳定事件表，不进入 timer 状态。
- 回滚不会重新创建函数对象，也不会产生“幽灵回调”。
- 推荐用枚举事件注册，而不是传箭头函数。

推荐写法：

```ts
export class EvokerModel extends PresetMonsterModel {
  public override readonly tickEventNames = [
    ...DEFAULT_TICK_EVENT_NAMES,
    TickEventNameEnums.EvokerSummon,
    TickEventNameEnums.EvokerResume,
  ];

  public override onCreate(entity: MonsterEntity): void {
    this.tickmanager.schedule(TickEventNameEnums.EvokerSummon, 28000, {
      startAt: 24000,
      repeat: 3,
    });
  }

  public override handleTickEvent(
    eventName: TickEventNameEnums | string,
    args: JsonValue = null,
    timerId?: number,
  ): void {
    if (eventName === TickEventNameEnums.EvokerSummon) {
      this.summonVindicator(this.host as MonsterEntity | null);
      return;
    }
    if (eventName === TickEventNameEnums.EvokerResume) {
      this.resumeAfterSummon(this.host as MonsterEntity | null);
      return;
    }
    super.handleTickEvent(eventName, args, timerId);
  }
}
```

事件参数必须是 JSON 安全的。例如 Boss 岩柱需要传 `{ col, row, hp }`，不要传植物对象或 Sprite。

全局 `TickerManager` 只用于 Manager 级系统定时器（如波次推进）。实体技能的定时器一律放在 Model。

<a id="model-lifecycle"></a>

## 5. 生命周期钩子

| 钩子 | 触发点 | 典型用途 |
| --- | --- | --- |
| `onCreate(host)` | Entity `initializeEntity()` 末尾 | 初始化技能 timer、建立视线、创建初始状态 |
| `onModelStep(host)` | Entity `stepUpdate()` | 每逻辑帧状态驱动判定 |
| `onModelCollision(host, target)` | Entity 碰撞转发 | 交互判定（现多在 `MonsterModel.onCollision` 统一处理） |
| `onModelHurt(host, amount, realDamage)` | 受伤流程 | 受击分支、阶段切换 |
| `onModelStarShards(host)` | 使用星碎 | 大招逻辑 |
| `onModelDestroy(host)` | Entity 销毁前 | 清理状态、通知关系目标 |

`PresetMonsterModel.createEntity()` 和 `PlantModel.createEntity()` 是工厂方法：先创建 Entity，再调用其 `initializeEntity()`。

<a id="model-rollback"></a>

## 6. Model 如何参与回滚

Model 的确定性字段通过 `snapshotModel(model)` 导出，保存在实体快照的 `flags.model` 中：

```ts
{
  flags: {
    model: this.model ? snapshotModel(this.model) : {},
    // 关系字段、PRNG、子类 captureLogicState() 也在 flags 中
  },
  timers: this.model?.captureTimers() ?? [],
}
```

恢复顺序由 `BaseEntity.restoreSnapshot()` 控制：

```text
关系字段 → PRNG → 子类 restoreLogicState() → Model 定时器
→ Model 字段 → hp/maxHp/speed → 位置/刚体
```

非枚举字段不进快照：

- `tickmanager`：由实体重建时新建，随后用 `restoreTimers()` 回填 timer 数据。
- `tickEventNames`：代码定义的常量列表。
- `host`：实体重建时通过 `attachHost()` 重新绑定。

因此 Model 只需要保证**会影响战斗结果的字段是 JSON 安全的普通字段**。定时器状态由 `EntityTickManager` 负责，不需要 Model 手写序列化。

<a id="model-host"></a>

## 7. 用例：从不同宿主访问世界

Model 的 `host` 是构造 Entity 时绑定的。由于 `attachHost()` 定义的是非枚举属性，它不会进入快照。

```ts
private summonVindicator(entity: MonsterEntity | null): void {
  if (!entity || entity.currentHealth <= 0) return;
  entity.stopAttacking();
  entity.stopMove();
  MobCmd.Spawn(VindicatorData.mid, entity.scene, col, row, -10);
}
```

更严格的写法是只依赖 `ModelHost`；但目前 preset 中常见做法是让具体 Model 使用具体 Entity 类型作为参数，以便调用动画入口。即使如此，也要遵守：

- Entity 方法只暴露“能力”（`playWardenLand()`、`startArcReposition()`），不决定伤害数值和触发条件。
- 决策留在 Model，例如 `WardenModel.onWardenLand()` 决定伤害和召唤，Entity 的 `onWardenLand()` 只播放落地动作。

详见 [Entity 能力边界](./2_entity.md#entity-boundary)。

## 8. 新增 Model 的检查清单

1. 继承 `PlantModel` / `MonsterModel` / `ObstacleModel` / `ProjectileModel`。
2. 静态数值定义为 class 字段；运行时状态定义为 JSON 安全字段。
3. 所有技能 timer 用 `this.tickmanager.schedule(eventName, ...)`。
4. 在 `tickEventNames` 中列出新增事件。
5. 覆写 `handleTickEvent()` 时，未知事件调用 `super.handleTickEvent()`。
6. 需要视图配合时，通过 `host` 调用 Entity 的纯表现方法。
7. 需要修改世界状态时调用 [Cmd](../kit/2_cmd.md#cmd-overview)。
8. 不要用 Entity 字段保存确定性状态；Entity 字段用 `declare`。
