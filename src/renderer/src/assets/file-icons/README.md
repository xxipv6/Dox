# 文件类型图标（VS Code 内置 Seti 主题）

`seti.woff` 与 `vs-seti-icon-theme.json` 原样取自 VS Code 仓库
`extensions/theme-seti/icons/`（上游数据来自 jesseweed/seti-ui，MIT）。
渲染逻辑在 `../../components/FileIcon.vue`：字体字形 + 主题 JSON 的
颜色/映射表，深浅两套主题（light 节）与 VS Code 完全一致。
