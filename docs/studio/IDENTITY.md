# Studio 应用身份

安装版：BiliNote Studio 0.1.0-preview.1，独立应用标识 `com.bilinote.studio`，默认后端仅监听 `127.0.0.1:38484`。

程序安装目录与 `%LOCALAPPDATA%\BiliNoteStudio` 数据目录分离。端口冲突时拒绝连接已有服务。原版 BiliNote 的应用身份、端口与数据库不复用；没有自动迁移旧数据。

源码保留早期内部便携实验的实现，但该实现不是本次公开分发形式。构建脚本必须使用安装版入口；实际安装验证见 ../../VALIDATION.md。
