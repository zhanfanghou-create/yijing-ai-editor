语音识别运行时（随包目录）
==========================

这个目录里的二进制**不入 git 仓库**，要跑语音识别（「字幕 → AI 识别字幕」）之前先执行：

    node tools/fetch-speech.mjs

它会下载 5 个文件（约 23MB）：
    sherpa-onnx.node                   推理插件（N-API，x64）
    sherpa-onnx-c-api.dll
    sherpa-onnx-cxx-api.dll
    onnxruntime.dll
    onnxruntime_providers_shared.dll

它们来自 k2-fsa/sherpa-onnx（Apache-2.0）与 microsoft/onnxruntime（MIT），
许可证全文见同目录的 LICENSE.txt。

不抓也能用：应用会在用户点「AI 识别字幕」时提示"运行时没装"，
并由「设置 → AI 模型」把这 5 个文件下载到 `<用户数据>/models/speech-runtime/`。
随包只是让新装的用户**装完即用**，不是唯一路径。

⚠️ 只放运行时，不放模型。识别模型（78MB 的中文轻量版 / 228MB 的多语种版）
   同样由「设置 → AI 模型」按需下载 —— 把它塞进安装包会让每个用户都多下 300MB，
   而绝大多数人一年也用不上一次。
