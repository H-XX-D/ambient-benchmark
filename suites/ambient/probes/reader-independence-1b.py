#!/usr/bin/env python3
# READER-INDEPENDENCE, the REAL control arm (area 4). A genuine ~1b instruct model
# (Llama-3.2-1B-Instruct via llama.cpp) answers questions about planted,
# unguessable facts WITH and WITHOUT the stored cell as context. The accuracy delta
# is the substrate's value over the bare model. This is the real test the mock
# in reader-independence.mjs stands in for.
#
# Run:
#   llama-server -hf unsloth/Llama-3.2-1B-Instruct-GGUF:Q4_K_M --port 8089 -c 2048 -ngl 99 --no-webui
#   python3 scripts/probes/reader-independence-1b.py
#
# Measured 2026-06-23 (Llama-3.2-1B-Instruct Q4_K_M, Apple Silicon Metal):
#   WITHOUT substrate 0/20 (0%), WITH substrate 20/20 (100%), delta 1.00.
import json, urllib.request, time

URL = "http://localhost:8089/v1/chat/completions"

def ask(prompt, max_tokens=24):
    body = json.dumps({"messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": max_tokens, "stream": False}).encode()
    req = urllib.request.Request(URL, data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer no-key"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)["choices"][0]["message"]["content"].strip()
        except Exception:
            time.sleep(1)
    return ""

N = 20
facts = []
for i in range(N):
    code = f"QX-{(i*7919+1234) % 10000:04d}-{chr(65 + (i % 26))}"
    facts.append({"i": i, "code": code,
                  "text": f"The vault access code for unit {i} is {code}.",
                  "q": f"What is the vault access code for unit {i}? Reply with only the code."})

def hit(ans, code):
    return code.lower().replace(" ", "") in ans.lower().replace(" ", "")

accW = accWo = 0
for f in facts:
    a_wo = ask(f["q"])
    a_w = ask(f"Context: {f['text']}\n\n{f['q']}")
    accW += hit(a_w, f["code"]); accWo += hit(a_wo, f["code"])

print(f"N={N}  (high-entropy planted codes the bare model cannot know)")
print(f"WITHOUT substrate: {accWo}/{N} = {round(accWo/N*100)}%")
print(f"WITH    substrate: {accW}/{N} = {round(accW/N*100)}%")
print(f"DELTA: {(accW-accWo)/N:.2f}")
