# SubContext

实时字幕上下文翻译浏览器扩展。支持从 Spotify、YouTube、ZDF 等网页捕获字幕，结合前后文批量翻译为自然的简体中文，并在页面中显示双语悬浮字幕。

## 功能

- 实时捕获 Spotify、YouTube、ZDF 字幕内容
- 结合上下文进行批量翻译，减少逐句翻译造成的断裂感
- 相邻分段自动润色，让字幕衔接更自然
- 支持 OpenAI 兼容接口、Gemini API、DeepSeek API
- 支持 Gemini / DeepSeek 思考模式配置
- 支持自定义 API Base URL，方便使用反代或中转服务
- 可开启原文校正提示，用于标记疑似拼写或听写错误
- 可隐藏译文时间戳、限制显示最近 N 行字幕
- 支持深色、浅色和自动主题

## 支持的模型服务

扩展当前支持以下服务商或接口格式：

- OpenAI 兼容接口
- Gemini
- DeepSeek

在设置页中可以分别填写 OpenAI、Gemini、DeepSeek 的 API Key。选择 Gemini 或 DeepSeek 模型时，扩展会使用对应服务商的 Key，不会回退到 OpenAI Key。

## 安装方式

1. 下载或克隆本仓库。
2. 打开 Chrome 或 Edge 的扩展管理页面。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”。
5. 选择本项目文件夹。

安装后，在支持的网站打开视频或歌词字幕，扩展会自动尝试捕获字幕并显示翻译悬浮窗。

## 使用方式

1. 打开扩展设置页。
2. 填写至少一个模型服务商的 API Key。
3. 在“模型参数”中选择要使用的模型。
4. 根据需要调整预取行数、连贯缓冲行数、温度和思考深度。
5. 回到播放页，打开字幕或转写面板，等待扩展自动翻译。

### YouTube 注意事项

YouTube 页面通常需要先打开“转写”面板，扩展才能读取完整字幕内容。如果是直播或回放页面，可能会因为页面未提供可抓取转写数据而无法翻译。

### DeepSeek 思考模式

选择 DeepSeek 模型时，设置页中的思考深度会自动切换为 DeepSeek 模式：

- `disabled`：关闭思考模式
- `high`：标准思考强度
- `max`：最高思考强度

DeepSeek 思考模式开启时，扩展会自动使用 DeepSeek 的 OpenAI 兼容参数。

## 项目结构

```text
.
├── manifest.json       # 浏览器扩展清单
├── background.js       # 后台服务、模型请求和翻译逻辑
├── contentScript.js    # 字幕捕获、页面悬浮窗和交互逻辑
├── options.html        # 设置页界面
├── options.js          # 设置页逻辑
├── popup.html          # 扩展弹窗
├── popup.js            # 弹窗逻辑
├── zdfBridge.js        # ZDF 页面桥接脚本
├── zdfPageHook.js      # ZDF 页面注入脚本
└── logo.png            # 扩展图标
```

## 隐私说明

API Key 和设置项保存在浏览器本地存储中。扩展会将需要翻译的字幕文本发送到你在设置中选择的模型服务商，用于生成翻译结果。

## 开发

本项目是原生浏览器扩展，不需要构建步骤。修改源码后，在扩展管理页点击“重新加载”即可生效。

可用以下命令检查主要脚本语法：

```powershell
node --check background.js
node --check contentScript.js
node --check options.js
```

## License

本项目基于 [MIT License](LICENSE) 开源。
