人物特效的随包运行时（二进制，不入库）

  node tools/fetch-mediapipe.mjs      # 从 node_modules + 官方地址抓

缺文件的症状：安装后点「人物特效 → 开始识别」报 Failed to fetch，
但开发模式下一切正常（开发模式从 node_modules 直接读）。
