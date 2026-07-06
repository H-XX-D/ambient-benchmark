# Reused corpus licenses and attribution

AMBIENT does not redistribute any third-party corpus. `reconstruct.py` fetches each
dataset from its official release and normalizes it locally. This keeps every license
intact and never forces the strictest license onto a bundle. Cite every source; never
present their questions as AMBIENT-authored.

## BEAM (used: small / medium / large tiers)
- Dataset license: CC BY-SA 4.0. Code: MIT. Paper: CC BY 4.0.
- ShareAlike: a modified, redistributed BEAM-derived corpus must be released under
  CC BY-SA 4.0. AMBIENT avoids this by reconstructing from source, not shipping data.
- Cite: Tavakoli, Salemi, Ye, Abdalla, Zamani, Mitchell, "Beyond a Million Tokens:
  Benchmarking and Enhancing Long-Term Memory in LLMs," arXiv:2510.27246, 2025.

## LongMemEval (used: small / medium / large tiers)
- Dataset and code license: MIT. Commercial use, modification, redistribution allowed;
  retain the notice "Copyright (c) 2024 Di Wu."
- Cite: Wu, Wang, Yu, Zhang, Chang, Yu, "LongMemEval: Benchmarking Chat Assistants on
  Long-Term Interactive Memory," ICLR 2025, arXiv:2410.10813.
- Use the cleaned variant (`xiaowu0162/longmemeval-cleaned`); the original is deprecated
  for noisy history sessions.

## LoCoMo (EXCLUDED)
- Dataset license: CC BY-NC 4.0 (NonCommercial). Excluded from AMBIENT because the NC
  clause blocks commercial or monetized-leaderboard use; LongMemEval covers the same
  small-tier pull + attribution role under MIT. Crawled dialogue images add a second,
  independent rights caveat.

## Provider-terms note (disclosure)
LoCoMo (GPT persona-agents) and LongMemEval filler derive from LLM output. Some provider
terms restrict using output to build competing models/services. A common reading binds
only the generating account, not downstream recipients, but it is unsettled. Disclosed
here for anyone running AMBIENT as a commercial product.

## Contamination hygiene
Reused public items risk train/test contamination and ceiling effects. AMBIENT keeps a
private held-out split with canary strings for headline numbers, and reports reused-vs-
authored item counts, rather than only re-serving saturated public items.
