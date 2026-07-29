---
title: My AMBIENT Memory Adapter
emoji: 🧠
colorFrom: gray
colorTo: blue
sdk: gradio
app_file: app.py
pinned: false
license: mit
---

# My AMBIENT memory Space

Duplicate this folder into a public Hugging Face Gradio Space, replace the
`write_memory` and `query_memory` functions in `app.py` with calls to your memory
system, and enter the resulting direct `https://…hf.space` URL in the AMBIENT
runner.

The starter is intentionally a tiny lexical memory so the wire contract works
before you connect your implementation. It namespaces every request with the
random `X-AMBIENT-Run-ID` supplied by the harness. Do not remove that isolation.

The Space must expose:

- `GET /name`
- `POST /reset`
- `POST /write`
- `POST /query`
- `POST /setAutoCapture`
- `POST /surface`
- `POST /dag`
- `POST /collection`

The AMBIENT runner does not send its Hugging Face OAuth token to this Space.
Make this adapter Space public and do not put private user data in benchmark
fixtures.
