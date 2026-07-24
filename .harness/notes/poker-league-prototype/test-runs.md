# Test runs — poker-league-prototype

- 2026-07-24 · TEST GATE (post-build, all 16 slices) · `npx vitest run` · **176 passed, 1 skipped, 0 failed** · green. Flaky integration issue fixed in slice 16 (fileParallelism:false); proven green on 3 consecutive runs from clean `supabase db reset`.
- Per-slice results (build phase): slice 1 → 2 · s2 seed/RLS verified · s3 → 4 · s4 → 13 · s5 → 19 · s6 → 23 · s7 → 28 · s8 → 37 · s9 → 66 · s10 → 82 · s11 → 108(+1 opt-in) · s12 → 137 · s13 → 147 · s14 → 159 · s15 → 174 · s16 → 176. All green at each checkpoint.
