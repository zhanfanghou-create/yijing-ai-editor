#!/usr/bin/env node
/**
 * MCP 工具表的**唯一清单** —— 两个闸门共用，避免各写一份。
 *
 * 少一个 = agent 少一项能力（它不会说"我少了"，只会默默做不出来）；
 * 多一个半成品 = agent 真的会去调。
 */

export const EXPECTED_TOOLS = [
  'yijing_status',
  'yijing_install',
  'yijing_open_app',
  'yijing_catalog',
  'yijing_list_drafts',
  'yijing_read_draft',
  'yijing_create_draft',
  'yijing_update_draft',
  'yijing_delete_draft',
  'yijing_duplicate_draft',
  'yijing_probe_media',
  'yijing_import_media',
  'yijing_add_clips',
  'yijing_add_subtitles',
  'yijing_update_clip',
  'yijing_delete_clips',
  'yijing_timeline_op',
  'yijing_list_materials',
  'yijing_add_sticker',
  'yijing_set_border',
  'yijing_apply_template',
  'yijing_apply_packaging',
  'yijing_apply_face_fx',
  'yijing_split_by_scenes',
  'yijing_plugins',
  'yijing_export_video',
  'yijing_pack_draft',
  'yijing_apply_plan'
]
