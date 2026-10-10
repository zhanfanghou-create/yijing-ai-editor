这个目录放 ffmpeg 的可执行文件（可选）

艺镜AI剪辑 是 MIT 许可的项目，而 ffmpeg 是 LGPL/GPL 许可的。
把 GPL/LGPL 的二进制默认塞进 MIT 的发行物，会让整份发行物的许可证说不清 ——
所以仓库里**不带** ffmpeg，安装包默认也不带。

文件名必须是 ffmpeg.exe（Windows）；ffprobe.exe 放在同一目录即可
（有它才能判断片段有没有音轨）。

三种拿到它的方式，任选一种：

1. 一键下载（推荐，需要网络）
     npm run ffmpeg:fetch
   它会把 ffmpeg.exe / ffprobe.exe 直接下载到这个目录。

2. 自己下载后放进来
   从 https://ffmpeg.org/download.html 选 Windows 构建，
   解压出 bin/ffmpeg.exe 与 bin/ffprobe.exe 拷到本目录。

3. 什么都不做
   程序会退回用系统 PATH 上的 ffmpeg（如果本机装过）。
   导出面板会显示"未检测到 ffmpeg"并给出安装提示。

放在这里的文件会被 .gitignore 排除，不会进 git。
构建安装器时：目录里有 ffmpeg.exe 就随包带走，没有就跳过（不影响打包）。
