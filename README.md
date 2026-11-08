# SubContext

**English** · [中文](README.zh-CN.md)

A browser extension (Chrome / Edge, Manifest V3) that translates the subtitles of ZDF, YouTube and Spotify into Simplified Chinese with an LLM (OpenAI, Gemini or DeepSeek). Each subtitle line appears together with its translation in a floating panel on the page.

## Why

I use SubContext to learn German with programmes from the ZDF Mediathek, YouTube videos and Spotify episodes. Translating subtitles line by line reads badly: one sentence is often spread over two or three subtitle lines, and names and pronouns lose what they refer to. Sending the whole transcript at once fixes that, but you pay for the entire video up front, and I often watch only about 15 minutes of an hour-long one. SubContext sits in between.

## How it works

1. **Capture.** A content script reads the timed subtitle lines from the page (see [Supported sites](#supported-sites)).
2. **Batches.** The lines are cut into batches of 8 (configurable). The batch at the playback position is translated first and the next one is prefetched, so translations are ready before the lines come up. Requests run one at a time, so every batch can build on the one before it.
3. **Context.** Each request also carries the last three lines of the previous batch, both the original and the translation. This keeps names, terms and tone consistent and lets the model continue a sentence that began in the previous batch.
4. **Smoothing the joins.** Once two neighbouring batches are translated, a second, small request sends the last 3 lines of the first batch and the first 3 lines of the second (original and translation, with the boundary marked). The prompt lets the model rewrite only the sentence that crosses the boundary and asks for every other line unchanged.

The model gets enough context to keep sentences whole, but only the part you actually watch (plus one batch ahead) is translated. Translations are cached for the current video, so seeking back does not translate again.

Optionally, the same request also asks for high-confidence fixes of spelling or speech-recognition errors in the original line; corrected words are highlighted in the panel.

## Supported sites

| Site | Where the subtitles come from |
| --- | --- |
| ZDF (`zdf.de`) | The programme's subtitle file, found through the player data |
| YouTube (`www.youtube.com`, `m.youtube.com`) | The transcript panel: open **Show transcript** below the video first |
| Spotify (`open.spotify.com`) | The subtitle track of the episode playing in the web player |

Videos without subtitles or a transcript, such as many live streams, cannot be translated.

## Install

There is no build step.

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and switch on **Developer mode**.
3. Click **Load unpacked** and select the repository folder. The extension appears as 字幕上下文翻译先锋版.

## Configure

Open the settings by right-clicking the extension's toolbar icon and choosing **Options**, or with the ⚙ button in the subtitle panel. The settings page is in Chinese, with English names in brackets for the main options.

1. Enter an API key for at least one provider: OpenAI, Google Gemini or DeepSeek.
2. Pick a model: `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.2`, `gpt-5.1` (default), `gemini-3-flash-preview`, `deepseek-v4-flash` or `deepseek-v4-pro`. The model decides which key and endpoint are used: Gemini models call the Gemini API, DeepSeek models the DeepSeek API, the others the OpenAI Chat Completions endpoint. There is no fallback to another provider's key.
3. Optional: set **API Base URL** to send OpenAI or DeepSeek requests through a compatible proxy or gateway.
4. Optional: change the batch size (**Context Size**, default 8), the lines on each side of a join (**Smooth Lines**, default 3), **Temperature** and **Thinking Level**, and display options such as hiding timestamps or showing only the last N lines.

Keys and settings stay in the browser's local extension storage (`chrome.storage.local`). Subtitle text is sent only to the model endpoint you configure.

## Use

Open a video on one of the supported sites and click the extension's icon in the browser toolbar. The panel opens and translation starts; closing the panel with × stops it. Click a line in the panel to copy its original text.

## Project layout

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 configuration and content scripts for the three sites |
| `contentScript.js` | Subtitle capture per site, batching and prefetch, join smoothing, floating panel |
| `background.js` | Service worker: prompts, context messages, API calls with timeout and retry |
| `options.html`, `options.js` | Settings page |
| `zdfPageHook.js`, `zdfBridge.js` | Spot the subtitle files the ZDF player loads and hand them to the content script |

## Limitations

- Not in the Chrome Web Store; load it unpacked as above.
- The target language is fixed to Simplified Chinese, and the interface is in Chinese.
- Capture depends on each site's page structure, so a redesign of YouTube, ZDF or Spotify can break it.

## License

[MIT](LICENSE)
