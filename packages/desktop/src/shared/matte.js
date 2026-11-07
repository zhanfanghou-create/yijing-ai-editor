/**
 * 智能抠像的共用常量（主进程与渲染层同一份）。
 *
 * 为什么这些数字要放 shared 而不是各写一份：
 *   `MATTE_MIN_COVERAGE` 在渲染层用来判"这段素材抠不到人"，
 *   在主进程用来判"这单活要不要判失败"。两边各写一个阈值，
 *   就会出现"界面说抠成功了，工具说没抠到"—— 用户看到两份相反的回答。
 */

/** 抠像推理的最大边长。1080p 缩到 1024 后遮罩质量看不出差别，耗时降一半 */
const MATTE_MAX_EDGE = 1024

/**
 * 前景占比低于这个值 = 没抠到主体。
 *
 * 0.5% 而不是 0：selfie_segmenter 在没有人物的画面上不会报错，
 * 而是给出一份几乎全零的 mask。直接乘上去就是整张透明，
 * 素材进了库、预览是空的，用户会以为是软件坏了。
 */
const MATTE_MIN_COVERAGE = 0.005

/** 视频抠像的采样帧率（15fps 足够，中间帧由播放器插值） */
const MATTE_FPS = 15

module.exports = { MATTE_MAX_EDGE, MATTE_MIN_COVERAGE, MATTE_FPS }
