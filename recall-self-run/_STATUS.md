# Status: single-system run, not cross-system

This directory is the empirical AMBIENT run from 2026-06-23 (the suite was named
SENTINEL then). It exercises exactly one memory system, Recall, and every script
imports Recall's build directly. It is kept as prior art and as the template for the
real runner.

It is not a cross-system benchmark and its numbers must not be presented as one. Per
the honesty bar, a benchmark only your own system can run is a demo with a
scoreboard. This becomes a real cross-system run only after the adapter contract and
a second, non-Recall adapter exist (see ROADMAP.md, phases P1 and P2). Renamed from
`cross-system-run` to `recall-self-run` to keep that honest.
