# 007 实测小样的源码

报告 [007](../../../007-可编辑视频的市场选择与作战方案.md) 第 1 节用到的全部源码.

- `engine.html`: 运行时 + 7 个组件 (6 个成片场景组件, 1 个透明素材组件).
- `doc_*.json`: 视频文档. 改这些 JSON 就是 "编辑视频".
- `render2.cjs`: 按场景缓存的渲染器 (Playwright 逐帧截图 + ffmpeg).

运行 (需要 Node 22, ffmpeg, Chromium):

```bash
npm i playwright @fontsource/noto-sans-sc@5
node render2.cjs engine.html doc_promo.json promo.mp4            # 26 秒成片
node render2.cjs engine.html doc_promo_editA.json promo_a.mp4    # 改两个数字, 只重渲染 2 个场景
node render2.cjs engine.html doc_promo_editB.json promo_b.mp4    # 换品牌色和名称
node render2.cjs engine.html doc_overlay.json overlay.mov --alpha  # 透明背景素材 (ProRes 4444)
```
