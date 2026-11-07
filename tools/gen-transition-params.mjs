/**
 * 转场参数分配器 —— 把**去重后的 204 个转场名字**各自映射到一组唯一的几何参数。
 *
 * ## 为什么要有这张表
 *
 * 转场卡片 331 张、去重名字 204 个，而 ffmpeg 的 `xfade` 只自带 58 种。
 * 于是"名字多、效果少"：点开二十张名字不同的卡，成片是同一个转场。
 * 修法不是删卡片（那是产品缩水），而是**把每个名字真的变成一个不同的转场** ——
 * 名字决定族与方向，族内用参数格子彼此错开。
 *
 * ## 表怎么读
 *
 *   L(名字, angle, soft, curve)  线性朝向：angle 是「后一段从哪边推进来」
 *                                0=从左边进(向右擦) 90=从上边进(向下擦)
 *                                180=从右边进 270=从下边进 45/135/225/315=对角
 *   R(名字, cx, cy, invert, rings) 圆 / 环：中心点 + 反向 + 同心环数
 *   A(名字, offset, arms)        扇形：起始角(0..1 圈) + 风车臂数
 *   S(名字, metric, invert, cx, cy) 距离场形状：manhattan 菱形 / chebyshev 方形
 *   G(名字, nx, ny, order)       网格：行列数 + 推进顺序(0 行 1 列 2 棋盘 3 径向)
 *   T(名字, n, axis, phase)      条纹：条数 + 方向(0 竖 1 横) + 相位(0 顺序 1 奇偶 2 乱序)
 *   W(名字, angle, freq, amp)    波浪边界：朝向 + 波数 + 振幅
 *   N(名字, scale, seed)         颗粒：格数 + 种子
 *   P(名字, turns, cx, cy)       螺旋：圈数 + 中心
 *   F(名字, tint)                全屏闪：0 黑 / 1 白 / 0.46 灰
 *
 * `soft` 是过渡带宽度：0.004 以下按硬边（成片走 gt，预览走硬遮罩）。
 * 硬边 + 软边 + 不同朝向互相组合，同一族里 40 个名字也不会撞。
 *
 * ⚠️ 改这张表之后必须跑：
 *     node tools/gen-transition-params.mjs --write      （写回真源与卡片）
 *     python tools/gen-material-thumbs.py               （重画转场缩略图）
 *     node tools/check-transition-parity.mjs            （表达式 vs 预览逐像素对拍）
 *     node tools/check-transition-distinct.mjs          （两两差异，防"两个名字一个效果"）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOOKS = path.join(ROOT, 'packages/desktop/src/shared/looks.json')
const MAT = path.join(ROOT, 'packages/desktop/src/renderer/materials.js')

/* ───────────────────────────── 参数格子 ───────────────────────────── */

const L = (zh, angle, soft, curve = 1, extra = {}) => [zh, { kind: 'lin', angle, soft, curve, ...extra }]
const R = (zh, cx, cy, invert = false, rings = 0, soft = 0.12, curve = 1) => [zh, { kind: 'radial', cx, cy, invert, rings, soft, curve }]
const A = (zh, offset, arms = 1, cx = 0.5, cy = 0.5, soft = 0.09) => [zh, { kind: 'angular', cx, cy, offset, arms, soft }]
const S = (zh, metric, invert = false, cx = 0.5, cy = 0.5, soft = 0.1) => [zh, { kind: 'shape', metric, cx, cy, invert, soft }]
const G = (zh, nx, ny, order = 0, soft = 0.02) => [zh, { kind: 'grid', nx, ny, order, soft }]
const T = (zh, n, axis = 0, phase = 0, soft = 0.02) => [zh, { kind: 'stripe', n, axis, phase, soft }]
const W = (zh, angle, freq, amp, soft = 0.05) => [zh, { kind: 'wave', angle, freq, amp, soft }]
const N = (zh, scale, seed, soft = 0.02) => [zh, { kind: 'noise', scale, seed, soft }]
const P = (zh, turns, cx = 0.5, cy = 0.5, soft = 0.06) => [zh, { kind: 'spiral', cx, cy, turns, soft }]
/**
 * 全屏闪：`tint` 是中间色（0 黑 / 1 白 / 0.46 灰），`depth` 只压到几成，
 * `shape` 让中间色像遮罩一样扫过（扫光 / 光束 / 炫光 / 故障条纹），
 * `soft` 是那条边的宽度。16 个名字靠 tint × depth × shape 三个维度分开。
 */
const F = (zh, tint, depth = 1, shape = null, soft = 0.3) =>
  [zh, { kind: 'flash', tint, depth, soft, ...(shape ? { shape } : {}) }]
/**
 * 光带闪：一条光带扫过画面（两端仍是原来的 A / B，只有经过的地方发光）。
 * `band` 是投影方向（lin / radial / angular / stripe）+ `hw` 半宽。
 * 与 F 的区别：F 是"整帧经过一个纯色"，FB 是"局部亮带滑过" —— 光效页那批名字要的是后者。
 */
const FB = (zh, tint, band, depth = 1) => [zh, { kind: 'flash', tint, depth, soft: 0.3, band }]
/** 全屏叠化：m 直接等于进度（等价于 xfade 的原生 fade） */
const U = (zh, curve = 1) => [zh, { kind: 'full', curve }]

/**
 * 名字 → 几何。**顺序即生成顺序**（写入 looks.json 时按这个顺序编号）。
 *
 * 分组照抄素材面板的 11 个页签（热门 / 最新 / 基础 / 叠化 / 幻灯片 / 模糊 Pro /
 * 故障 / 运镜 / 扭曲 / 3D / 光效），但分配是按"几何族"来做的 ——
 * 同族的名字彼此只差参数，跨族的名字形状就不同。
 *
 * ⚠️ 表里写的 `soft` 只是**初值**：同族同向的条目会被 `separate()` 按阶梯重新
 * 分配 `curve`（时间曲线）与 `soft`（过渡带宽度）。原因是实测 —— "soft 0.44 与
 * 0.5"这种差别在成片和缩略图上都看不出来（外观差 0.010，约 2.5/255），
 * 而"线性 / 慢起 / 快起"三个时间曲线之间的差是 0.13~0.35，一眼可辨。
 */
export const ASSIGN = [
  /* ── 全屏叠化：m 直接等于进度 ── */
  U('叠化'),
  U('渐显', 2),
  U('柔和渐变', 1.6),

  /* ── 线性擦除 / 滑动：最常见的一大族（angle 是"后一段从哪边推进来"） ── */
  L('向右', 0, 0.004),
  L('上移', 270, 0.004),
  L('向上', 270, 0.16),
  L('下移', 90, 0.004),
  L('向下', 90, 0.16),
  L('向下滑动', 90, 0.3),
  L('左移', 180, 0.004),
  L('右移', 0, 0.16),
  L('向左 Ⅱ', 180, 0.16),
  L('快速向右', 0, 0.004, 0.55),
  L('向右擦除', 0, 0.06),
  L('向左擦除', 180, 0.06),
  L('向上擦除', 270, 0.06),
  L('向下擦除', 90, 0.06),
  L('渐变擦除', 0, 0.44),
  L('阴影擦拭', 180, 0.36),
  L('快速擦漆', 315, 0.004, 0.55),
  L('向左拉屏', 180, 0.004, 2),
  L('镜头切换', 0, 0.004, 6),
  L('嗖', 45, 0.24, 0.55),
  L('快速拉动', 225, 0.004, 0.5),
  L('快速放大', 45, 0.004, 0.45),
  L('推近', 90, 0.2, 1.6),
  L('拉远', 270, 0.2, 0.6),
  L('缩小', 90, 0.44, 2.2),
  L('缩放', 270, 0.44, 0.45),
  L('超级放大', 45, 0.004, 0.35),
  L('前后对比', 0, 0.004, 3),
  L('相片切换', 180, 0.24),
  L('边框切换', 315, 0.16),
  L('横向模糊 Ⅱ', 0, 0.5),
  L('横移模糊', 180, 0.5),
  L('竖向模糊', 90, 0.5),
  L('模糊', 0, 0.62),
  L('基础模糊', 180, 0.62),
  L('模糊放大', 45, 0.62, 0.5),
  L('放大模糊', 225, 0.62, 0.5),
  L('模糊收缩', 45, 0.5, 2.4),
  L('模糊变焦', 315, 0.56, 0.4),
  L('加载过渡', 90, 0.36),
  L('快速平移相机', 180, 0.004, 0.35),
  L('180扫', 180, 0.004, 4),
  L('弹跳下移', 90, 0.004, 3),
  L('左溶解', 180, 0.5, 0.6),
  L('叠化扭曲', 45, 0.3, 1.8),

  /* ── 圆 / 环 ── */
  R('圆形渐入', 0.5, 0.5, false, 0, 0.12),
  R('圆形渐出', 0.5, 0.5, true, 0, 0.12),
  R('圆圈展开', 0.5, 0.5, false, 0, 0.004),
  R('大圆盘', 0.5, 0.5, false, 0, 0.3),
  R('径向爆发', 0.5, 0.5, false, 0, 0.004, 0.45),
  R('径向涟漪', 0.5, 0.5, false, 3, 0.06),
  R('中心点水波纹', 0.5, 0.5, false, 2, 0.1),
  R('冲击波', 0.5, 0.5, false, 4, 0.004),
  R('液滴扩散', 0.5, 0.42, false, 0, 0.08),
  R('泡泡旋转', 0.62, 0.38, false, 2, 0.14),
  R('泡泡模糊', 0.38, 0.62, false, 3, 0.2),
  R('吸入', 0.5, 0.5, true, 0, 0.3),
  R('闪光俯卧撑', 0.5, 0.5, false, 5, 0.004),
  R('闪屏故障', 0.5, 0.5, true, 2, 0.02),
  R('雾化', 0.5, 0.5, false, 0, 0.45),
  R('雾闪', 0.5, 0.5, false, 0, 0.62),
  R('焦点模糊', 0.5, 0.5, false, 0, 0.5),
  R('径向模糊', 0.5, 0.5, false, 0, 0.7),
  R('亮点模糊', 0.62, 0.38, false, 0, 0.55),
  R('缩放回声', 0.5, 0.5, false, 2, 0.18),
  R('火花缩放', 0.5, 0.5, false, 3, 0.004),
  R('溶解放大', 0.5, 0.5, false, 0, 0.004, 0.7),
  R('波点向右', 0.5, 0.5, false, 8, 0.02),
  R('水滴出血', 0.5, 0.5, false, 6, 0.004),

  /* ── 扇形 / 风车 / 旋转 / 翻卷 ── */
  A('风车', 0, 4),
  A('旋转1', 0, 1),
  A('旋转2', 0.25, 1),
  A('顺时针旋转', 0.5, 1),
  A('360度旋转', 0.75, 1),
  A('空间旋转', 0.125, 2),
  A('转轮', 0.625, 3),
  A('球体扭曲↖', 0.875, 3),
  A('球体扭曲↗', 0.5, 2),
  A('球体扭曲↘', 0.25, 2),
  A('球体扭曲↙', 0.75, 2),
  A('鱼眼卷←', 0.125, 4),
  A('鱼眼卷→', 0.375, 4),
  A('鱼眼卷↑', 0.625, 4),
  A('鱼眼卷↓', 0.875, 4),
  A('旋焦', 0.5, 3),
  A('旋转开关', 0.25, 4),
  A('翻页', 0.5, 1, 0.5, 0.5, 0.2),
  A('翻页2', 0.5, 1, 0.5, 0.5, 0.34),
  A('3D翻转', 0.75, 1, 0.5, 0.5, 0.22),
  A('立方翻转', 0.25, 1, 0.5, 0.5, 0.26),
  A('盒子翻转向下↓', 0.25, 2, 0.5, 0.5, 0.18),
  A('盒子翻转向上↑', 0.75, 2, 0.5, 0.5, 0.18),
  A('盒子翻转向左←', 0.5, 2, 0.5, 0.5, 0.18),
  A('盒子翻转向右→', 0, 2, 0.5, 0.5, 0.18),
  A('向左模糊翻卷←', 0.5, 1, 0.5, 0.5, 0.4),
  A('向右模糊翻卷→', 0, 1, 0.5, 0.5, 0.4),
  A('向上模糊翻卷↑', 0.75, 1, 0.5, 0.5, 0.44),
  A('向下模糊翻卷↓', 0.25, 1, 0.5, 0.5, 0.44),
  A('左上模糊翻卷↖', 0.625, 1, 0.5, 0.5, 0.36),
  A('右下模糊翻卷↘', 0.125, 1, 0.5, 0.5, 0.36),
  A('右上模糊翻卷↗', 0.875, 1, 0.5, 0.5, 0.32),
  A('左下模糊翻卷↙', 0.375, 1, 0.5, 0.5, 0.32),

  /* ── 菱形 / 方形距离场 ── */
  S('菱形叠化', 'manhattan', false, 0.5, 0.5, 0.12),
  S('方形分割', 'chebyshev', false, 0.5, 0.5, 0.004),
  S('四屏转换', 'chebyshev', false, 0.5, 0.5, 0.2),
  S('分割', 'manhattan', false, 0.5, 0.5, 0.004),
  S('三屏滑入', 'chebyshev', true, 0.5, 0.5, 0.004),
  S('四格展开', 'manhattan', true, 0.5, 0.5, 0.1),
  S('双开门替换', 'chebyshev', true, 0.5, 0.5, 0.3),
  S('面板打开', 'chebyshev', false, 0.5, 0.5, 0.14),
  S('卡片弹出', 'manhattan', false, 0.5, 0.42, 0.06),
  S('积木', 'chebyshev', false, 0.5, 0.5, 0.06),
  S('镜像翻转', 'manhattan', true, 0.5, 0.5, 0.2),
  S('立方体替换', 'chebyshev', false, 0.5, 0.5, 0.28),
  S('3D替换', 'chebyshev', true, 0.5, 0.5, 0.14),

  /* ── 网格 / 马赛克 ──
     ⚠️ 这三条原本是 order 0（逐行推进），实测**与「下移」「水平线」画出来几乎一样**
     （封面对比 ΔE 1.92，肉眼不可分；遮罩层面只在边界软硬和台阶上有差）。
     顺序推进的场值只按行递增，任何进度都是"上面若干整行已翻"——那就不是网格，是横带擦除。
     名字叫马赛克/漫画，用户期待的是块，所以改 order 2（棋盘交错）：块边界天然显现，
     与全库最近的一条也差 0.23 以上（改造前 0.04）。order 0 的"逐行"口径保留在 fieldGrid 里，
     只是不该给这几个名字用。 */
  G('马赛克', 8, 8, 2),
  G('马赛克5', 5, 5, 1),
  G('马赛克Ⅱ', 12, 8, 2),
  G('马赛克爆发', 6, 6, 3),
  G('马赛克扭曲', 4, 4, 3),
  G('网络马赛克', 16, 9, 2),
  G('像素故障', 20, 12, 2),
  /* `块故障` 与 `马赛克5` 都是 5 列的顺次推进，只是一个 5 行一个 3 行 ——
     逐帧看是同一个竖前沿，差 0.0214。故障类的应该是块在乱跳，改 order 4。 */
  G('块故障', 5, 3, 4),
  G('拼贴故障', 7, 5, 2),
  G('漫画输出', 3, 3, 2),
  /* order 4 = 乱序翻转（像素块随机跳），只有「故障」类的最大那块用得上 */
  G('像素屏幕故障', 24, 14, 4),

  /* ── 条纹 / 百叶 ──
     ⚠️ 细条纹（n ≥ 8）的 soft 必须接近**一个叶片的宽度**（1/n），否则每片叶子
        只是一个 1/12~1/18 宽的硬台阶，整条转场看着就是"打了台阶的硬擦除" ——
        实测 `水平线`(18 级) 与 `下移`(硬边平移) 外观只差 0.0185（≈4.7/255）。
        让叶片自带渐变之后，看到的是一排平行的斜边，才不是一条平滑前沿。 */
  T('百叶窗', 8, 1, 1),
  T('百叶窗2', 6, 0, 1),
  T('快门', 12, 0, 0, 0.1),
  T('交错切换', 10, 1, 2),
  /* 顺次推进的条数不能太多：实测 n=18 的横向条与 `下移` 只差 0.0185（台阶太细，
     等于一条平滑前沿），n=8~10 才回到 0.036~0.041 的"闸门安全区"。
     ⚠️ 光是"顺次推进"无论怎么调都分不开：**任何进度都是单边界**，与连续平移同形。
     实测 soft 顶到叶宽（0.125）也只从 1.92 抬到 2.36 ΔE。真正的区别是**交错**：
     phase 1 让隔条先翻，38% 时是"一半横线换掉"的百叶窗，与整幅下移一眼可分。
     条数取 12（「百叶窗」是 8），两条也不会撞。 */
  T('水平线', 12, 1, 1),
  /* 垂线走 phase 1（交错翻转）而不是顺次推进：顺次推进的 18 级台阶
     与 `向右`（硬边平滑推进）在逐帧看来几乎是同一条竖前沿，只差前沿的台阶粗细。 */
  T('垂线', 18, 0, 1),
  T('上下翻页', 4, 1, 0, 0.28),
  T('竖向开幕', 2, 0, 0),
  T('三屏闪切', 3, 0, 1),
  T('快门模糊', 14, 0, 1, 0.3),

  /* ── 波浪边界 ── */
  W('水波纹', 0, 3, 0.06),
  W('水波纹2', 0, 5, 0.1),
  W('波纹溶解', 0, 8, 0.16),
  W('梦幻波纹溶解', 45, 4, 0.12),
  W('水波卷动', 90, 3, 0.2),
  W('流动涟漪', 90, 6, 0.1),
  W('波动故障', 0, 13, 0.24),
  W('云朵', 45, 2, 0.24),
  W('水墨', 90, 2, 0.16),
  W('油墨扩散', 270, 5, 0.08),
  W('复古模糊', 45, 7, 0.14),
  W('颜色摇动', 270, 9, 0.18),

  /* ── 颗粒 / 故障 ── */
  N('色彩溶解', 8, 1),
  N('色彩溶解Ⅱ', 14, 4),
  N('粒子重新组装', 22, 9),
  N('雪花故障', 36, 2),
  N('腐烂故障', 56, 5),
  N('故障', 10, 3),
  N('故障2', 16, 7),
  N('故障3', 28, 11),
  N('电视故障', 6, 6),
  N('电视故障Ⅰ', 44, 8),
  N('信号丢失', 64, 12),
  N('信号丢失Ⅱ', 18, 13),
  N('故障扫描', 30, 14),
  N('镜头故障', 12, 15),
  N('颜色故障', 40, 16),
  N('毛刺闪光', 9, 17),
  N('毛刺闪光Ⅱ', 26, 18),
  N('闪烁回声', 48, 19),
  N('漫画撕纸', 7, 20),
  N('模拟犯罪', 20, 21),
  N('负故障', 32, 22),
  N('故障模糊', 52, 23),
  N('闪烁模糊', 11, 24),
  N('抖动叠化', 24, 25),
  N('摇一摇二', 60, 26),

  /* ── 螺旋 ── */
  P('螺旋扭曲', 2),
  P('扭曲漩涡', 3),
  P('扭曲旋转', 1.5, 0.5, 0.5, 0.08),
  P('扭曲', 1, 0.5, 0.5, 0.04),
  P('扭曲放大', 4, 0.42, 0.42),
  P('流体扭曲', 5, 0.58, 0.58),
  P('拉伸扭曲', 2.5, 0.35, 0.5),
  P('拉伸', 1.25, 0.65, 0.5),
  P('弹跳变形', 3.5, 0.5, 0.62),
  P('旋转变焦', 2.2, 0.5, 0.5, 0.1),
  P('时光穿梭', 4, 0.5, 0.5, 0.004),
  P('抖动放大', 0.8, 0.5, 0.5, 0.12),

  /* ── 全屏闪：中间色三件事 —— tint（压到哪个灰阶）、depth（压到几成）、
        以及中间色**怎么出现**：
          · 什么都不带  = 整帧同时压一下（闪黑 / 闪白）
          · shape       = 中间色像遮罩一样铺满再退掉（黑扫 / 白溶解）
          · band        = 一条光带扫过，两端画面原样（扫光 / 光束 / 电光 / 炫光）
        tint 单独排不出 16 个能一眼分开的效果（0 / 0.02 / 0.04 人眼分不出），
        所以光效类的名字全部走 band。 ── */
  F('闪黑', 0),
  F('闪白', 1),
  F('闪黑叠化', 0, 0.78),
  F('闪光褪色', 0.8, 0.9),
  F('黑色反转闪光', 0.02, 1, { kind: 'lin', angle: 180, soft: 0.004 }),
  F('黑色翻转片', 0.04, 1, { kind: 'lin', angle: 90, soft: 0.1 }),
  F('闪光白色溶解', 1, 1, { kind: 'noise', scale: 14, seed: 31, soft: 0.4 }),
  FB('扫光', 1, { kind: 'lin', angle: 0, hw: 0.16 }),
  FB('光束', 1, { kind: 'lin', angle: 90, hw: 0.12 }),
  FB('流光', 1, { kind: 'lin', angle: 30, hw: 0.3 }),
  FB('电光', 0.9, { kind: 'angular', arms: 3, offset: 0.2, hw: 0.22 }),
  FB('闪烁光芒', 1, { kind: 'angular', arms: 6, hw: 0.12 }),
  FB('炫光', 0.85, { kind: 'radial', invert: true, hw: 0.3 }),
  FB('炫光Ⅱ', 0.75, { kind: 'radial', rings: 2, hw: 0.2 }),
  FB('发光变焦', 0.95, { kind: 'radial', hw: 0.35 }),
  FB('曝光故障', 1, { kind: 'stripe', n: 9, axis: 1, hw: 0.1 })
]

/* ───────────────────────────── 写盘 ───────────────────────────── */

/** 稳定 key：同一名字永远同一个 key（草稿里存的是它，必须可复现） */
function hashOf(text) {
  let h = 5381
  const s = String(text)
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36).padStart(6, '0').slice(-6)
}

/**
 * 极短的中文提示，写进转场下拉里的悬浮说明。
 * `curve` 也是区分同族条目的主要手段（见 separate），所以提示里要带上节奏，
 * 否则两条"从左推进"看不出差别在哪。
 */
function hintOf(geo) {
  const pace = geo.curve > 1.25 ? ' · 慢起' : geo.curve < 0.85 ? ' · 快起' : ''
  return baseHint(geo) + (geo.kind === 'full' || geo.kind === 'flash' ? '' : pace)
}

function baseHint(geo) {
  switch (geo.kind) {
    case 'lin': {
      const dir = { 0: '从左', 45: '从左上', 90: '从上', 135: '从右上', 180: '从右', 225: '从右下', 270: '从下', 315: '从左下' }[Math.round(geo.angle)]
      const edge = geo.soft < 0.01 ? '硬边' : geo.soft > 0.45 ? '大范围柔化' : '软边'
      return `${dir}推进 · ${edge}`
    }
    case 'radial':
      return geo.rings ? `${geo.rings} 道同心环扩散` : geo.invert ? '从四周收向中心' : '从中心向外扩散'
    case 'angular':
      return geo.arms > 1 ? `${geo.arms} 臂风车扫过` : '沿圆周顺时针扫过'
    case 'shape':
      return `${geo.metric === 'chebyshev' ? '方形' : '菱形'}${geo.invert ? '收拢' : '展开'}`
    case 'grid':
      return `${geo.nx}×${geo.ny} 网格${['逐行', '逐列', '棋盘', '由内向外'][geo.order] || ''}切换`
    case 'stripe':
      return `${geo.n} 条${geo.axis ? '横向' : '竖向'}条纹${geo.phase === 2 ? '乱序' : geo.phase === 1 ? '奇偶交错' : '依次'}切换`
    case 'wave':
      return `${geo.freq} 个波峰的边界推进`
    case 'noise':
      return `${geo.scale}×${geo.scale} 颗粒随机溶解`
    case 'spiral':
      return `${geo.turns} 圈螺旋展开`
    case 'flash': {
      const tone = geo.tint > 0.7 ? '白光' : geo.tint < 0.2 ? '黑场' : '灰光'
      const deep = geo.depth < 0.95 ? `（只到 ${Math.round(geo.depth * 100)}%）` : ''
      if (geo.band) {
        const how = {
          lin: '一道光横扫',
          radial: geo.band.rings ? `${geo.band.rings} 道光环扩散` : geo.band.invert ? '光环向内收' : '光斑从中心炸开',
          angular: `${geo.band.arms} 条光芒旋转扫过`,
          stripe: `${geo.band.n} 条光带扫过`
        }[geo.band.kind] || '光带扫过'
        return `${how} · ${tone}`
      }
      if (geo.shape) {
        const how = {
          lin: '一道边扫过',
          radial: '一圈边扩开',
          angular: '扇面铺开',
          noise: '光粒溶解'
        }[geo.shape.kind] || '带形状地'
        return `${how}${tone}${deep}`
      }
      return `整帧同时${tone}${deep}`
    }
    case 'full':
      return geo.curve > 1.2 ? '慢起的整体叠化' : geo.curve < 0.9 ? '快起的整体叠化' : '整体叠化，两段直接相交'
    default:
      return ''
  }
}

/**
 * 时间曲线阶梯 —— 同族同向的条目按阶梯重派 soft / curve。
 *
 * 这些数字不是随手挑的，实测过的（32×32 采样、按"最像的那个进度"算外观差）：
 *   · 相邻 `soft`（0.1 一档）只差 0.021 —— 约 5/255，**看不出来**；
 *   · `soft` 跨三档（0.004 → 0.34 → 0.62）差 0.03~0.05 —— 硬边与大片羽化，一眼可辨；
 *   · 相邻 `curve`（1 → 1.6）差 0.13~0.35 —— 一眼能看出快慢不同。
 * 所以取 **soft 主序、curve 次序**：hard↔feathered 是物理上最直观的一维，
 * 同一 soft 档用完了（4 条）才换下一个 curve 档。容量 4 × 6 = 24。
 *
 * ⚠️ 两条约束别踩：
 *   ① **分组大小为 1 的原样保留** —— 否则手工调的柔边（径向模糊、雾化）全被抹成硬边；
 *   ② 重派前先按**作者写的 soft 升序**排，硬边保持硬、羽化保持柔，语义不倒挂。
 */
const CURVE_LADDER = [1, 1.6, 0.62, 2.2, 0.45, 2.8]
const SOFT_LADDER = [0.004, 0.34, 0.62, 0.92]

/** 同族同向分不开的条目，按阶梯重派 soft / curve（flash 另有规矩，不动） */
function separate(rows) {
  const groups = new Map()
  for (const r of rows) {
    /* 闪族的差别在 tint / depth / band / shape 上，改它的 soft 是另一码事 */
    if (r.geo.kind === 'flash') continue
    const { soft, curve, ...rest } = r.geo
    const sig = JSON.stringify(rest)
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig).push(r)
  }
  const sizes = []
  for (const [, list] of groups) {
    sizes.push(list.length)
    for (const r of list) r.hint = hintOf(r.geo)
    if (list.length === 1) continue
    /* 作者写的 soft 升序：最硬的排第一，重派后仍然是硬，柔的仍然是柔 */
    const sorted = list.slice().sort((a, b) => (a.geo.soft ?? 0.3) - (b.geo.soft ?? 0.3))
    sorted.forEach((r, i) => {
      if (r.geo.kind === 'full') {
        /* 整帧同进度，没有空间场可言 —— 只能靠时间曲线分开 */
        if (i >= CURVE_LADDER.length) {
          throw new Error(`同族（full）条目太多，${r.label} 分不到唯一档位（${list.length} 条）`)
        }
        r.geo.curve = CURVE_LADDER[i]
      } else {
        const cycle = Math.floor(i / SOFT_LADDER.length)
        if (cycle >= CURVE_LADDER.length) {
          throw new Error(`同向条目太多，${r.label} 分不到唯一档位（${list.length} 条）`)
        }
        r.geo.soft = SOFT_LADDER[i % SOFT_LADDER.length]
        r.geo.curve = CURVE_LADDER[cycle]
      }
      r.hint = hintOf(r.geo)
    })
  }
  return Math.max(...sizes)
}

function main() {
  const write = process.argv.includes('--write')
  const seen = new Map()
  const rows = []
  for (const [zh, geo] of ASSIGN) {
    if (!zh) throw new Error('空名字')
    if (seen.has(zh)) throw new Error(`名字重复：${zh}`)
    seen.set(zh, geo)
    rows.push({ key: `tx-${hashOf(zh)}`, label: zh, hint: hintOf(geo), ffmpeg: 'custom', geo, defaultDuration: 0.6 })
  }

  /* 同族同向按阶梯重派 curve / soft —— 见 separate() 的注释 */
  const biggest = separate(rows)
  console.log(`同向最大分组 ${biggest} 条（阶梯容量 ${CURVE_LADDER.length * SOFT_LADDER.length}）`)
  /* 204 个效果必须两两不同：同族内按几何签名查重，跨族天然不同 */
  const sig = new Map()
  for (const r of rows) {
    const s = JSON.stringify(r.geo)
    if (sig.has(s)) throw new Error(`参数撞车：${sig.get(s)} 与 ${r.label} 是同一组几何`)
    sig.set(s, r.label)
  }
  const keyDup = new Map()
  for (const r of rows) {
    if (keyDup.has(r.key)) throw new Error(`key 撞车：${keyDup.get(r.key)} 与 ${r.label}`)
    keyDup.set(r.key, r.label)
  }

  console.log(`分配 ${rows.length} 个转场（含 ${new Set(rows.map((r) => r.geo.kind)).size} 个几何族）`)

  /* 与卡片对照：materials.js 里出现的每个名字都必须有分配，反之亦然 */
  const src = fs.readFileSync(MAT, 'utf8')
  const start = src.indexOf('export const TRANSITION_GROUPS')
  const end = src.indexOf('export const ', start + 10)
  const body = src.slice(start, end < 0 ? src.length : end)
  const cardNames = [...new Set([...body.matchAll(/\{\s*zh:\s*"([^"]+)"/g)].map((m) => m[1]))]
  const missing = cardNames.filter((n) => !seen.has(n))
  const extra = [...seen.keys()].filter((n) => !cardNames.includes(n))
  if (missing.length) throw new Error(`卡片里有 ${missing.length} 个名字没有分配参数：${missing.slice(0, 6).join(' / ')}`)
  if (extra.length) throw new Error(`分配表里有 ${extra.length} 个名字卡片上不存在：${extra.slice(0, 6).join(' / ')}`)
  console.log(`卡片名字 ${cardNames.length} 个，与分配表一一对应`)

  if (!write) {
    console.log('\n（只检查，未写盘。加 --write 落盘）')
    return
  }

  /* ① looks.json：保留原有 58 条 + none（老草稿仍能查到时长的兜底），追加 204 条 */
  const looks = JSON.parse(fs.readFileSync(LOOKS, 'utf8'))
  const keep = looks.transitions.filter((t) => !t.key.startsWith('tx-'))
  looks.transitions = [...keep, ...rows]
  fs.writeFileSync(LOOKS, `${JSON.stringify(looks, null, 2)}\n`, 'utf8')

  /* ② materials.js：把每张卡的 css 换成对应 key
     ⚠️ 只改 TRANSITION_GROUPS 这一段内的卡：滤镜/特效页里也有同名卡
        （"模糊""故障""马赛克"三组都出现过），全文件替换会把它们的键一起改掉 */
  const tStart = src.indexOf('export const TRANSITION_GROUPS')
  const tEnd = src.indexOf('export const ', tStart + 10)
  const head = src.slice(0, tStart)
  const block = src.slice(tStart, tEnd < 0 ? src.length : tEnd)
  const tailSrc = tEnd < 0 ? '' : src.slice(tEnd)
  let replaced = 0
  const newBlock = block.replace(
    /(\{\s*zh:\s*"([^"]+)"\s*,\s*thumb:\s*"([^"]*)"\s*,\s*css:\s*")([^"]*)(")/g,
    (all, lead, zh, thumb, css, close) => {
      const hit = seen.has(zh) ? rows.find((r) => r.label === zh) : null
      if (!hit) return all
      replaced += 1
      return `${lead}${hit.key}${close}`
    }
  )
  fs.writeFileSync(MAT, head + newBlock + tailSrc, 'utf8')
  console.log(`写回：looks.json ${keep.length + rows.length} 条转场；materials.js 改写 ${replaced} 张卡`)
}

if (process.argv[1] && process.argv[1].endsWith('gen-transition-params.mjs')) main()
