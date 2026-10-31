'use strict'
/**
 * 艺镜AI剪辑 · MCP server（stdio）
 *
 * 让「艺镜·镜枢」的 agent 完整驱动剪辑软件：装软件 → 建草稿 → 上时间线 → 调色字幕特效
 * → 套模板/包装/边框/贴纸 → 导出成片，全过程不需要人点鼠标。
 *
 * ── 为什么是一个独立脚本、而不是「应用内加个 --mcp 开关」 ──────────────
 * 实测（2026-10-10）：Windows 上 Electron 是 **GUI 子系统**，主进程被父进程以管道
 * 拉起时 **stdin 立刻 EOF** —— 父进程写进来的第一行就收不到，"应用自己当 stdio server"
 * 这条路根本走不通。必须让 exe 以 **`ELECTRON_RUN_AS_NODE=1`** 当纯 Node 跑，
 * 这时 stdio 才是标准 Node 行为（同一份实测：`echo` 来回 + 优雅关闭都成立）。
 * 所以镜枢的 mcp.json 里 command 是 exe、args 是本文件、env 带 `ELECTRON_RUN_AS_NODE=1`。
 *
 * ── 为什么能直接复用主进程的 render.js ──────────────────────────────
 * render.js / looks.js / subtitles.js **零 electron 依赖**（只有 index.js require electron），
 * 而且 `process.resourcesPath` 在 RUN_AS_NODE 下仍指向安装目录的 `resources`，
 * 于是随包 ffmpeg 的查找逻辑原样可用。导出与界面导出**走同一条管线**，
 * 不存在"agent 导出来和界面导出来不一样"。
 *
 * ── 工具怎么排 ───────────────────────────────────────────────────
 * 每个工具只做一件事，名字就是动作；把"这套功能有哪几种合法值"集中放进
 * `yijing_catalog`，而不是让 agent 去猜 key（猜错必须报错，不许静默无效）。
 * 能力实现全在 `mcp-ops.js`（那一层可以脱离 stdio 单测）。
 *
 * ── 铁律 ───────────────────────────────────────────────────────────
 * stdout **只许**出现 JSON-RPC 报文。任何日志/进度/警告一律走 stderr ——
 * 往 stdout 写一个字符就会让对面解析失败、整条链路静默断掉。
 */
const path = require('node:path')
const fs = require('node:fs')

const { createDraftStore } = require('./drafts')
const { createOps } = require('./mcp-ops')

const SERVER_NAME = 'yijing-editor'
const SERVER_VERSION = '1.1.0'
const PROTOCOL_VERSION = '2024-11-05'

/* ------------------------------ 基础环境 ------------------------------ */

/**
 * 草稿根目录。镜枢拉起本进程时由主进程在 env 里带**权威值**（`YIJAI_USER_DATA`），
 * 避免在 MCP server 里猜 Electron 的 userData 命名规则（`@yijing/desktop` 这种
 * 带作用域的怪名，猜错就是"agent 建的草稿软件里看不到"，还不报错）。
 * 兜底值只用于手工调试。
 */
function userDataDir() {
  const fromEnv = process.env.YIJAI_USER_DATA
  if (fromEnv) return fromEnv
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, '@yijing', 'desktop')
  }
  return path.join(process.env.HOME || '.', '.yijing-editor')
}

const dataDir = userDataDir()
const store = createDraftStore(() => dataDir)
const ops = createOps({ store, userDataDir: dataDir, resourcesPath: process.resourcesPath, mainDir: __dirname })

/* ------------------------------ 工具表 ------------------------------ */
// description 是给 agent 看的**唯一的**说明书：写清"什么时候用、参数怎么给"，
// 而不是重复参数名。agent 看不见我们的界面，全靠这几句话决定怎么调。

const S = (description, properties = {}, required = []) => ({
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }
})
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })

const TOOLS = {
  /* ============================ 环境 / 生命周期 ============================ */

  yijing_status: {
    ...S('查这台机器上的剪辑环境：版本、草稿目录、ffmpeg 是否可用、随包贴纸/边框/模板数量、主程序是否已安装。开始干活前先调一次，能提前发现"没有 ffmpeg 导不了片"。'),
    handler: () => ({ ...ops.status(), app: ops.appStatus() })
  },

  yijing_install: {
    ...S(
      '无人值守安装剪辑软件（静默安装，不需要人点下一步）。装完可直接用 yijing_open_app 打开。返回安装目录、exe 路径与耗时。',
      {
        installerPath: str('安装包 exe 的绝对路径（省略则用环境变量 YIJAI_INSTALLER）'),
        installDir: str('安装目录（省略则装到 %LOCALAPPDATA%\\Programs\\艺镜AI剪辑）'),
        launch: { type: 'boolean', description: '装完是否立刻启动主程序（默认 false）' },
        shortcuts: { type: 'boolean', description: '是否创建桌面/开始菜单快捷方式（默认 true）' },
        noRegister: { type: 'boolean', description: '不写注册表登记（便携/临时目录安装用，默认 false）' },
        timeoutMs: num('超时毫秒数，默认 300000')
      },
      // 刻意**不**设为必填：没传时 ops.install 会退回 YIJAI_INSTALLER 环境变量。
      // 写成必填会让"环境变量已配好"的场景反而被调用方卡住。
      []
    ),
    handler: (args) => ops.install(args)
  },

  yijing_open_app: {
    ...S(
      '启动剪辑软件；给了 draftId 就直接打开那份草稿（用户能在界面上看到 agent 改出来的东西）。',
      {
        draftId: str('要打开的草稿 id（省略则只启动软件，停在首页）'),
        installDir: str('安装目录（主程序不在默认位置时用；省略则按已安装位置/YIJAI_APP_PATH 找）')
      }
    ),
    handler: (args) => ops.openInApp(args)
  },

  /* ================================ 目录 ================================ */

  yijing_catalog: {
    ...S('拿全部合法取值：滤镜 / 转场 / 画面特效 / 文字样式 / 调节参数 / 曲线通道 / HSL 色带 / 蒙版 / 混合模式 / 关键帧属性 / 人物特效 / 模板 / 包装风格 / 贴纸 / 边框 / 编码 / 帧率 / 分辨率 / 画面比例 / 插件。任何"该填哪个 key"的问题先查这里，不要猜。'),
    handler: () => ops.catalog()
  },

  /* ================================ 草稿 ================================ */

  yijing_list_drafts: {
    ...S('列出已有草稿（项目）。开始编辑前先用它找到目标草稿，或确认还没有草稿。'),
    handler: () => ops.listDrafts()
  },

  yijing_read_draft: {
    ...S(
      '读取一个草稿的完整内容：时间线所有片段（视频/叠加/音频/字幕四轨）、素材库、画面比例、播放头。改之前必须先看清现状，片段 id 都从这里拿。',
      { draftId: str('草稿 id（yijing_list_drafts 里拿）') },
      ['draftId']
    ),
    handler: (args) => ops.readDraft(args)
  },

  yijing_create_draft: {
    ...S(
      '新建空白草稿，返回 draftId。画面比例可选 1:1 / 1:2 / 3:4 / 9:16 / 16:9 / 4:3 / 2:1。',
      {
        name: str('草稿名（省略则叫「未命名项目」加日期）'),
        aspect: str('画面比例，默认 16:9'),
        playhead: num('初始播放头秒数，默认 0')
      }
    ),
    handler: (args) => ops.createDraft(args)
  },

  yijing_update_draft: {
    ...S(
      '改草稿本身：改名、改画面比例、移动播放头、改预览音量与缩放。',
      {
        draftId: str('草稿 id'),
        name: str('新名字'),
        aspect: str('新画面比例（1:1 / 1:2 / 3:4 / 9:16 / 16:9 / 4:3 / 2:1）'),
        playhead: num('播放头秒数'),
        volume: num('预览音量 0..200，默认 100'),
        zoom: num('时间线缩放 0.1..20，默认 1')
      },
      ['draftId']
    ),
    handler: (args) => ops.updateDraft(args)
  },

  yijing_delete_draft: {
    ...S(
      '删除草稿（不可恢复）。删之前先确认 id。',
      { draftId: str('要删的草稿 id') },
      ['draftId']
    ),
    handler: (args) => ops.deleteDraft(args)
  },

  yijing_duplicate_draft: {
    ...S(
      '复制一份草稿（连同片段与素材表）。做"试一版不同剪法"时用它，别在原稿上试。',
      {
        draftId: str('源草稿 id'),
        name: str('副本名字（省略则在原名后加「副本」）')
      },
      ['draftId']
    ),
    handler: (args) => ops.duplicateDraft(args)
  },

  /* ================================ 素材 ================================ */

  yijing_probe_media: {
    ...S(
      '探测本地音视频/图片：类型、真实时长、有没有音轨/视频轨、分辨率、是否 HDR，并返回可直接写进草稿的素材信息。加片段前先探测，时长就不用自己估算。',
      {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '素材绝对路径列表（Windows 路径直接写盘符，如 D:/clips/a.mp4）'
        }
      },
      ['paths']
    ),
    handler: (args) => ops.probeMedia(args)
  },

  yijing_import_media: {
    ...S(
      '把文件放进草稿的素材库（**不落轨**）。想让内容上时间线用 yijing_add_clips。',
      {
        draftId: str('目标草稿 id'),
        paths: { type: 'array', items: { type: 'string' }, description: '素材绝对路径列表' }
      },
      ['draftId']
    ),
    handler: (args) => ops.importMedia(args)
  },

  /* =============================== 时间线 =============================== */

  yijing_add_clips: {
    ...S(
      '把音视频/图片追加到时间线。track：video=主轨、overlay=叠加轨（画中画）、audio=音频轨。不给 duration 就用素材真实时长；offset 是从素材第几秒开始取。每段还能带 patch 直接套调色/特效/位置（省一次 update）。',
      {
        draftId: str('目标草稿 id'),
        clips: {
          type: 'array',
          description: '要添加的片段',
          items: {
            type: 'object',
            properties: {
              path: str('素材绝对路径'),
              track: str('video / overlay / audio'),
              start: num('时间线起点（秒），默认 0'),
              duration: num('片段时长（秒），省略用素材真实时长'),
              offset: num('从素材第几秒开始（秒），默认 0'),
              name: str('显示名'),
              patch: { type: 'object', description: '顺带套用的字段（同 yijing_update_clip 的 patch）' }
            }
          }
        },
        name: str('追加出来的片段显示名前缀（可选）')
      },
      ['draftId', 'clips']
    ),
    handler: (args) => ops.addClips(args)
  },

  yijing_add_subtitles: {
    ...S(
      '往字幕轨加字幕。可以直接给条目（text/start/duration），也可以给 file（.srt/.vtt/.lrc/.ass 绝对路径）或 content（文件正文）由软件自己解析；offset 整体平移（秒）。style 取 catalog 的 textStyles。',
      {
        draftId: str('目标草稿 id'),
        subtitles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: str('字幕正文'),
              start: num('出现时间（秒）'),
              duration: num('持续时长（秒），默认 3')
            },
            required: ['text', 'start']
          }
        },
        file: str('字幕文件绝对路径（SRT/VTT/LRC/ASS）'),
        content: str('字幕文件正文（没有文件时用）'),
        filename: str('正文对应的文件名（用来判断格式，可选）'),
        offset: num('整体平移秒数，可负'),
        style: str('样式 key，默认 sub-plain'),
        name: str('字幕轨显示名（可选）')
      },
      ['draftId']
    ),
    handler: (args) => ops.addSubtitles(args)
  },

  yijing_update_clip: {
    ...S(
      '改一个片段的任何属性 —— 位置/缩放/旋转/透明度/速度/音量/淡入淡出、滤镜与强度、转场、画面特效、调色（adjust/curves/wheels/hslBands）、变形（warp/crop）、高级效果 effects（圆角/蒙版/抠像/描边/阴影/混合模式）、文字样式与动画、关键帧、画中画、边框、人物特效、停用（enabled:false，可逆，片段仍占位）。只传要改的字段；字段名写错会**报错**，不会静默无效。',
      {
        draftId: str('草稿 id'),
        clipId: str('片段 id'),
        patch: { type: 'object', description: '要覆盖的字段（见 yijing_catalog 与工具说明）' }
      },
      ['draftId', 'clipId', 'patch']
    ),
    handler: (args) => ops.updateClip(args)
  },

  yijing_delete_clips: {
    ...S(
      '从时间线删除一个或多个片段（只删片段，不动素材库里的源文件）。clipIds 一次可以给多个。',
      {
        draftId: str('草稿 id'),
        clipIds: { type: 'array', items: { type: 'string' }, description: '要删的片段 id 列表' }
      },
      ['draftId', 'clipIds']
    ),
    handler: (args) => ops.deleteClips(args)
  },

  yijing_timeline_op: {
    ...S(
      '时间线结构操作。op：move（换轨/挪时间）、split（at 处切开）、trim（from/to 掐头去尾）、duplicate（复制到自身之后）、group/ungroup（组合）、compound（合成复合片段）/expand（拆开）、multicam（多机位）/cut（切机位）、region-copy/region-paste/region-delete/region-trim（时间区域操作）、reorder（挪到某个时间点）、layer（叠加轨上移/下移一层，to 或 name 给 up/down）。',
      {
        draftId: str('草稿 id'),
        op: str('move/split/trim/duplicate/group/ungroup/compound/expand/multicam/cut/region-copy/region-paste/region-delete/region-trim/reorder/layer'),
        clipId: str('目标片段 id'),
        clipIds: { type: 'array', items: { type: 'string' }, description: '批量操作的片段 id' },
        at: num('时间点（秒）：split 的切点 / cut 的位置 / paste 的落点 / reorder 的新起点'),
        from: num('起始：trim 的新开头 / region 的起点 / cut 的机位号'),
        to: num('结束：trim 的新结尾 / region 的终点（秒）/ layer 的方向（1 上移，-1 下移）'),
        name: str('名字（组合标签 / 复合片段名 / layer 的方向 up|down）'),
        mode: str('region-delete 的 mode：ripple（默认，后面内容左移）/ gap（留空）')
      },
      ['draftId', 'op']
    ),
    handler: (args) => ops.timelineOp(args)
  },

  /* ============================== 素材库能力 ============================== */

  yijing_list_materials: {
    ...S(
      '列内置素材：kind=sticker 贴纸 / border 边框 / all。返回每项的 key 与名字，套用前先看有什么。',
      { kind: str('sticker / border / all，默认 all') }
    ),
    handler: (args) => ops.listMaterials(args)
  },

  yijing_add_sticker: {
    ...S(
      '把贴纸放到叠加轨（画中画）。stickerKeys 来自 yijing_catalog 的 stickers。anchor 是九宫格位置，size 是占画面宽度的百分比。',
      {
        draftId: str('草稿 id'),
        stickerKeys: {
          type: 'array',
          items: { type: 'string' },
          description: '贴纸 key 列表（取 catalog 的 stickers）；多枚会自动错开 0.1 秒'
        },
        start: num('落点秒数，默认 0'),
        duration: num('每枚停留秒数，默认 4'),
        anchor: str('九宫格位置，如 top-left / center / bottom-right'),
        size: num('占画面宽度百分比，默认取 pip.json'),
        name: str('显示名')
      },
      ['draftId', 'stickerKeys']
    ),
    handler: (args) => ops.addSticker(args)
  },

  yijing_set_border: {
    ...S(
      '给片段套边框（片段属性，不是投放片段）。border 取 catalog 的 borders；传空串或 "none" 清除。可批量。',
      {
        draftId: str('草稿 id'),
        clipId: str('单个片段 id'),
        clipIds: { type: 'array', items: { type: 'string' }, description: '批量片段 id（与 clipId 二选一）' },
        border: str('边框 key（catalog 的 borders），空串或 none 表示清除')
      },
      ['draftId', 'border']
    ),
    handler: (args) => ops.setBorder(args)
  },

  yijing_apply_template: {
    ...S(
      '套内置成套模板（片头/片尾/包装/章节）。templateKey 取 catalog 的 templates；start 是落地时间，titleText 填主标题。',
      {
        draftId: str('草稿 id'),
        templateKey: str('模板 key（catalog 的 templates）'),
        start: num('落地秒数，默认时间线末尾'),
        titleText: str('主标题文字（模板里带文字位时用）')
      },
      ['draftId', 'templateKey']
    ),
    handler: (args) => ops.applyTemplate(args)
  },

  yijing_apply_packaging: {
    ...S(
      '智能包装。mode=line（按字幕逐句套样式与贴纸）/ scene（主轨每段统一边框+调色）/ strip（清除包装）。style 与 level 取 catalog。',
      {
        draftId: str('草稿 id'),
        style: str('风格 key（catalog 的 packaging），默认 web-yellow'),
        level: str('强度 light / normal / strong，默认 normal'),
        mode: str('line / scene / strip，默认 line'),
        combo: { type: 'object', description: '自定义组合（覆盖 style 推出来的那套）' }
      },
      ['draftId']
    ),
    handler: (args) => ops.applyPackaging(args)
  },

  yijing_apply_face_fx: {
    ...S(
      '人物特效：面部打码 / 提亮 / 主角描边，跟随人脸。识别在界面里跑（MediaPipe 478 点），agent 也可以自己给人脸框：boxes=[{t,x,y,w,h}]，坐标是相对源画面的 0..1 归一化值，t 是片段内秒数。已有 faceTrack 时不用再给。fx 传 "none" 清除。',
      {
        draftId: str('草稿 id'),
        clipId: str('片段 id'),
        fx: str('blur / bright / frame / none'),
        strength: num('强度 0..1，默认 0.6'),
        boxes: { type: 'array', description: '人脸框序列', items: { type: 'object' } },
        track: {
          type: 'array',
          description: '已算好的人脸框序列（与 boxes 同义；有 faceTrack 时直接透传）',
          items: { type: 'object' }
        }
      },
      ['draftId', 'clipId', 'fx']
    ),
    handler: (args) => ops.applyFaceFx(args)
  },

  yijing_split_by_scenes: {
    ...S(
      '按画面切换把一段视频自动切成多段（ffmpeg 场景检测，threshold 默认 0.35，越大越不敏感）。',
      {
        draftId: str('草稿 id'),
        clipId: str('要切的主轨片段 id（省略则切整条主轨）'),
        threshold: num('检测灵敏度 0..1，默认 0.35（越大越不敏感）')
      },
      ['draftId']
    ),
    handler: (args) => ops.splitByScenes(args)
  },

  yijing_plugins: {
    ...S(
      '本地素材包（自定义边框/贴纸）：list / install（给素材包目录）/ enable / disable。',
      {
        action: str('list / install / enable / disable，默认 list'),
        dir: str('素材包目录绝对路径（install 时必填）'),
        id: str('素材包 id（enable / disable 时必填）')
      },
      ['action']
    ),
    handler: (args) => ops.plugins(args)
  },

  /* ================================ 导出 ================================ */

  yijing_export_video: {
    ...S(
      '把草稿导出成成片（真实调 ffmpeg，滤镜/转场/字幕/画中画/调色/特效全部进成片）。编码与容器必须匹配：h264/h265/h265-10 → .mp4，prores-* → .mov。cover 是导出封面（时间点是成片内秒数）；range 只导一段时间。',
      {
        draftId: str('草稿 id'),
        outPath: str('输出绝对路径（扩展名要与编码匹配：.mp4 / .mov）'),
        codec: str('编码：h264 / h265 / h265-10 / prores-422 / prores-4444，默认 h264'),
        resolution: str('分辨率档：480p/720p/1080p/2k/4k/8k，默认 1080p'),
        width: num('精确输出宽度像素（覆盖 resolution 档；与 height 一起给）'),
        height: num('精确输出高度像素（覆盖 resolution 档）'),
        fps: num('帧率：24/25/29.97/30/50/59.94/60，默认 30'),
        quality: num('画质 10–100，默认 80'),
        aspect: str('覆盖画面比例，默认沿用草稿'),
        cover: { type: 'object', description: '{ enabled:true, at:秒 } 导出封面 jpg' },
        range: { type: 'object', description: '{ start, end } 只导这段（秒）' },
        loudness: str('响度处理模式（catalog 的 loudnessModes）'),
        backdrop: str('自定义背景图路径（可选）')
      },
      ['draftId', 'outPath']
    ),
    handler: (args) => ops.exportVideo(args)
  },

  yijing_pack_draft: {
    ...S(
      '把草稿与它引用的素材打成一个 .yjpack 工程包（换机器继续剪用）。',
      {
        draftId: str('草稿 id'),
        outPath: str('输出 .yjpack 绝对路径（省略则落到用户数据目录）')
      },
      ['draftId']
    ),
    handler: (args) => ops.packDraft(args)
  },

  /* ============================== 一次成型 ============================== */

  yijing_apply_plan: {
    ...S(
      '一次执行整套方案：按顺序跑一串工具调用（steps=[{tool, args}]），任意一步失败就停下并返回失败位置与已完成步骤。做完整任务时用它，比逐个调工具更省来回；draftId 会被自动填进每一步（步骤里给了就用自己的）。',
      {
        draftId: str('默认草稿 id（自动填进没写 draftId 的步骤）'),
        steps: {
          type: 'array',
          description: '步骤列表，例如 [{tool:"yijing_add_clips", args:{clips:[...]}}]',
          items: {
            type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' } },
            required: ['tool']
          }
        }
      },
      ['steps']
    ),
    handler: async ({ draftId, steps = [] }) => {
      const list = Array.isArray(steps) ? steps : []
      if (!list.length) throw new Error('steps 是空的')
      const done = []
      for (let i = 0; i < list.length; i++) {
        const step = list[i] || {}
        const name = String(step.tool || '')
        const tool = TOOLS[name]
        if (!tool) throw new Error(`第 ${i + 1} 步：未知工具「${name}」`)
        const args = { ...(step.args || {}) }
        if (draftId && args.draftId === undefined) args.draftId = draftId
        try {
          const out = await tool.handler(args)
          done.push({ step: i + 1, tool: name, ok: true })
          if (out && out.draftId) draftId = out.draftId
        } catch (e) {
          const msg = String((e && e.message) || e)
          throw new Error(`第 ${i + 1} 步「${name}」失败：${msg}（已完成 ${done.length} 步）`)
        }
      }
      return { steps: done.length, done, draftId }
    }
  }
}

/* ------------------------------ JSON-RPC ------------------------------ */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function log(...args) {
  process.stderr.write('[yijing-mcp] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
}

/** 工具名 → 结果。text 里放人类可读的 JSON，agent 直接读得懂 */
async function callTool(name, args) {
  const tool = TOOLS[name]
  if (!tool) throw new Error(`未知工具：${name}`)
  const result = await tool.handler(args || {})
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }
    }
  }
  if (method === 'notifications/initialized') {
    /**
     * 标准 MCP 里通知不带 id、也不该有响应 —— 但镜枢的 client 用同一个 `_rpc()`
     * 发它，**同样分配了 id 并等回包**（30s 没回就判整条连接失败）。所以这里
     * 按通用规则处理：**只要来包带 id 就回一个空 result**；不带 id 则静默。
     * 对标准 client 无副作用，对镜枢则是"能连上"的前提。
     */
    return id == null ? null : { jsonrpc: '2.0', id, result: {} }
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(TOOLS).map(([n, t]) => ({ name: n, description: t.description, inputSchema: t.inputSchema }))
      }
    }
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    try {
      const out = await callTool(String(name), args)
      return { jsonrpc: '2.0', id, result: out }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e && e.message) }], isError: true } }
    }
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } }
}

/* ------------------------------ 启动 ------------------------------ */

let buffer = ''
let queue = Promise.resolve()

function drain(line) {
  const text = line.trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    log('忽略无法解析的一行')
    return
  }
  // 串行处理：两个 tools/call 并发写同一份草稿会互相覆盖（后写赢）
  queue = queue.then(async () => {
    const reply = await handle(msg)
    if (reply) send(reply)
  })
}

/**
 * ⚠️ 只在**被直接执行**时挂 stdio —— 被 require（自检脚本）时挂上 stdin 监听
 * 会让进程永远退不出去，闸门就会卡死在那里。
 */
if (require.main === module) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) drain(line)
  })
  process.stdin.on('end', () => {
    if (buffer.trim()) drain(buffer)
    queue.then(() => process.exit(0))
  })

  process.on('uncaughtException', (e) => log('未捕获异常：' + String(e && e.stack)))
  process.on('unhandledRejection', (e) => log('未处理的拒绝：' + String(e)))

  log(`启动 server=${SERVER_NAME} pid=${process.pid} userData=${dataDir} tools=${Object.keys(TOOLS).length}`)
}

/* 供自检脚本直接拿到工具表（只有被 require 时才暴露） */
module.exports = { TOOLS, callTool, handle, SERVER_NAME, SERVER_VERSION }
