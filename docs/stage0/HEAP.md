# Stage 0.1: heap cost

**Verdict: flat heap found.** A 16-wide trie of tuples, with objects as
tuples, costs the same per op at 256, 1.3k, 10.5k and 102.7k live objects for
read, write, alloc, and for passing the heap on by alias argument, `infer`,
`infer … extends C` or a state tuple. One condition applies: no
_generic-looking_ type may be reachable from the heap (rule H1). Passing the
heap only as an alias argument (rule H2) makes the cost flat even when H1 is
broken. Staged snapshots are not needed to keep heap cost flat.

All numbers are instantiations from `--extendedDiagnostics` on **stock**
tsrs 0.23.0-ts7.1.0-beta (`TSRS_FAST=1 tsrs --fast --singleThreaded`),
unless marked "diag" (the instrumented build; its counts equal stock).
Cost per op is `(inst(2K) − inst(K)) / K` with K = 100 (K = 20 for table E).

## Root cause of cost 3

References are to tsrs v0.23.0 (tag commit `fc38431`), `crates/tsrs_checker/src/`, unpatched line numbers.

1. **Every resolved conditional type instantiates its check type twice.**
   `get_conditional_type_worker` (checker_12.rs:1323) resolves
   `X extends E ? A : B` with non-generic X. First it calls
   `get_permissive_instantiation(check_type)` (checker_12.rs:1440, defined at 1623) to rule out "definitely false". Then it calls
   `get_restrictive_instantiation(check_type)` (checker_12.rs:1505, defined at 1637) to confirm "definitely true". This holds for `X extends infer h`, for
   `S extends [infer A, infer H, …]` and for `infer h extends C` alike. Both
   results are cached **per type id** only, so every _new_ heap value (each
   write or alloc makes one) is instantiated again, twice.
2. **Instantiation descends into every node that "could contain type
   variables".** `instantiate_type_with_alias` (checker_11.rs:1262) returns
   a type unchanged only if its cached `CouldContainTypeVariables` flag is
   false. Otherwise it instantiates the type, and for a tuple or interface
   reference that means all its type arguments, recursively. Each visited node
   is one counted instantiation (checker_11.rs:1318–1371). The walk of a new
   heap root therefore covers every node on a path to a flagged leaf, which is
   O(young objects), not O(changed path). The cache inside the walk is the
   active-mapper cache, which is dropped after the call.
3. **Which leaves are flagged.**
   `could_contain_type_variables_worker` (checker_11.rs:1520) says yes for:
   - type parameters;
   - object type literals and other anonymous types whose symbol is a
     `TypeLiteral`/`ObjectLiteral`/function, and mapped types
     (checker_11.rs:1536–1551);
   - deferred type references (`node` set, checker_11.rs:1532);
   - any type whose alias has flagged alias type arguments
     (`instantiate_type_with_alias_slow`, checker_11.rs:1292).

   But two things make _instantiated_ types safe:
   - When an anonymous type, mapped type or deferred reference is
     **instantiated**, tsrs (like tsgo) carries the flag forward from the
     mapped type arguments (checker_11.rs:1878–1893). `{ a: Id }` built by an
     alias with `Id = "x"`, or a deferred tuple `[Id, E0]`, is _not_ flagged.
   - A top-level alias with no type parameters is never flagged
     (`is_non_generic_top_level_type`, checker_11.rs:1569).

   So the flag stays true only on **uninstantiated source types that are not
   the body of a top-level alias**. Typical cases are a literal `{ … }` or
   mapped type written inside an interface member, an alias argument (such as
   the boot image's `HStatic<…, { "0": TStatic<…, { "sa": "0" … }, …> }>`), or
   a value read out of such a type.

**Reproduced in lua-in-types** (`lua_repro.sh`, the lua runtime imported
read-only; a forced bind `Store<…> extends infer h ? h : never` per op):

| young heap holds                         | shapes        | fill 0 | fill 1,500 |
| ---------------------------------------- | ------------- | -----: | ---------: |
| copies of boot-image tables (`Load<H0>`) | type literals |    169 |  **6,802** |
| fresh tables (`TNew`)                    | type literals |    169 |        169 |
| copies of boot-image tables              | interfaces    |    169 |        169 |
| unforced `Store` (no bind), any          | any           |    161 |        161 |

Diag for the 6,802 case: instantiations under the permissive mapper went
from 2,432 to 334,384 and under the restrictive mapper from 2,433 to
334,385 for the 100 binds. That is ~6,690 per bind, which accounts for the
whole 6,633 increase. By label, they are `alias TStatic` (303k) and
`object:anonymous` (298k), the image shapes. This is lua's cause 1. With
interface shapes the micro case is flat.

**Not found:** the generic-looking value that still sits in the real tslua
run's young slot arrays (lua's AOT.md: interface shapes did not help there;
dropping slot arrays did). It is some uninstantiated source type reachable
from young tables. One diag run on that state names it:
`TSRS_HEAPDIAG=1` prints `inst_permissive`/`inst_restrictive`, and the
by-alias table shows what is walked. Two hypotheses failed before the time box
ran out:

- deferred tuple references (`E1 = [E0, …]`, `ANew`) are not flagged when
  they are top-level aliases or have been instantiated;
- `{}` copied out of `TNew` by `TSetS` is flat in the micro case.

Ruled out as O(heap) by the counters (constant per op at every N):
relation-key computation (`get_relation_key_worker`, checker_09.rs:920, and
its generic-argument walk at checker_09.rs:949), `inferFromTypes` steps,
`isDeeplyNestedType` calls, type-reference creation, and
`couldContainTypeVariables` computations (O(new nodes) per op).

## Measurements

Shared across candidates: 5-hex-digit ids, trie paths most significant digit
first, 16-wide nodes, and a heap box `[next, root]` (or `HP<next, root>`).
Each benchmark has a 256-object working set plus N other live objects, and
the ops touch the working set. Read = `Fld<Get<H, id>, "0">`; write =
`Store<H, id, SetF<Get<H, id>, "1", v>>` (read-modify-write of one field);
alloc = store at `next` plus `next` bump; none = pass the heap on unchanged.
Binds: `arg` = the loop passes `Op<H>` as an alias argument; `infer` =
`Op<H> extends infer H2 ? Loop<H2, …>`; `inferc` = `infer H2 extends
[string, unknown]`; `tuple` = state `[H, I, A]` taken apart by
`S extends [infer H, infer I, infer A]`.

**A. tuple nodes, 16-field tuple objects** (`node=tuple obj=t16`): recommended

| op    | bind   | N=0 | 1,024 | 10,240 | 102,400 |
| ----- | ------ | --: | ----: | -----: | ------: |
| read  | arg    |  59 |    59 |     59 |      59 |
| read  | infer  |  65 |    65 |     65 |      65 |
| read  | inferc |  65 |    65 |     65 |      65 |
| read  | tuple  | 106 |   106 |    106 |     106 |
| write | arg    | 413 |   413 |    413 |     413 |
| write | infer  | 416 |   416 |    416 |     416 |
| write | inferc | 426 |   426 |    426 |     426 |
| write | tuple  | 413 |   413 |    413 |     413 |
| alloc | arg    | 354 |   358 |    364 |     364 |
| alloc | infer  | 357 |   361 |    367 |     367 |
| alloc | inferc | 367 |   371 |    377 |     377 |
| alloc | tuple  | 354 |   358 |    364 |     364 |
| none  | arg    |  11 |    11 |     11 |      11 |
| none  | infer  |  15 |    15 |     15 |      15 |
| none  | inferc |  15 |    15 |     15 |      15 |
| none  | tuple  |  11 |    11 |     11 |      11 |

Alloc's +10 from N=0 to N=10,240 is the alloc path entering a non-empty
subtree, which costs a few more node rebuilds than an empty one. It does not
grow from there to 102,400.

**B. tuple nodes, lua-style tables** (an 8-tuple holding a 16-slot tuple, `obj=lua`), all flat:

| op    |     arg |   infer |  inferc |   tuple |
| ----- | ------: | ------: | ------: | ------: |
| read  |      59 |      65 |      65 |     106 |
| write |     420 |     423 |     433 |     420 |
| alloc | 359–369 | 362–372 | 372–382 | 359–369 |
| none  |      11 |      15 |      15 |      11 |

**C. tuple nodes, 8-field interface objects** (`obj=i8`), all flat:

| op    |     arg |   infer |  inferc |   tuple |
| ----- | ------: | ------: | ------: | ------: |
| read  |      70 |      76 |      76 |     117 |
| write |     410 |     413 |     423 |     410 |
| alloc | 336–346 | 339–349 | 349–359 | 336–346 |
| none  |      11 |      15 |      15 |      11 |

**D. generic-interface nodes and box, 16-field interface objects**
(`node=iface obj=i16`), all flat:

| op    |     arg |   infer |  inferc |   tuple |
| ----- | ------: | ------: | ------: | ------: |
| read  |      81 |      87 |      87 |     118 |
| write |     536 |     536 |     539 |     536 |
| alloc | 424–434 | 424–434 | 424–434 | 424–434 |
| none  |      11 |      15 |      15 |      11 |

(Ranges are N=0 … 102,400 and stop growing at 10,240. Every other cell is
identical at all four N.)

**E. candidate A with the trigger** (each object holds one value copied from
a source-written object literal, `ImgV["k"]` with
`interface ImgV { k: { a: "x" } }`; write, K=20):

| bind   |   N=0 | 1,024 | 10,240 |                   102,400 |
| ------ | ----: | ----: | -----: | ------------------------: |
| arg    |   412 |   412 |    412 |                       412 |
| infer  | 1,527 | 5,895 | 45,215 | TS2589 (5M per statement) |
| inferc | 1,537 | 5,905 | 45,225 |                    TS2589 |
| tuple  |   412 |   412 |    412 |                       412 |

Diag at N=10,240: 2,836 walk instantiations per write (permissive and
restrictive mappers), and 5,661 per alloc. `arg` walks nothing. The
`tuple` loop is flat here only because its state tuple
`[Write<…>, At<…>, A]` is a deferred reference, so it is not something to
rely on. An earlier version of the loop, whose state tuple was not deferred,
grew from 2,075 to 32,169 per op between N=0 and N=10,240.

**Relation cache** (diag `rel/op`, new relation-cache entries per op, N=10,240):
2–4 per op for every candidate and bind. In a long run (candidate A, alias-arg
loop, 102,656 live objects, chained statements of 500 writes), the relation
size was **2,697 after 10,000 writes and still 2,697 after 50,000**: it does
not grow. Totals: 6,124,350 instantiations for 10k writes and 21,805,790 for
50k, so **392 per write over the long run**. Stock check time was 0.46 s and
memory 112 MB, including building the 102k-object heap. The same run on
candidate D cost 518 per write, 2.33 s and **974 MB**; candidate C cost 19.7M
instantiations, 0.53 s and 174 MB.

A trap found on the way, which matters for the emitter's dispatch tables:
`T[K & keyof T]` with a fresh K on an M-key interface adds about 5·M relation
entries per lookup. In 100 lookups the relation size reached 5,474 (M=100),
502,724 (M=1,000) and **15,963,816 (M=10,000)**, which is the 16M TS2859
limit (relater_1.rs:664). `K extends keyof T ? T[K] : never` costs about M
once and then ~1 per lookup: 425, 1,325 and 10,325. My first loop scaffold
used the `&` form on 100–200-key tables, which added ~234 entries per step
until it was replaced.

Wall time: per-op times are below the 1 ms resolution of the CLI's check
time. One oddity: with tuple nodes, the `inferc` and `tuple`-read loops pay
a one-off ~0.5 s and ~430 MB that grows with neither N nor K. Interface nodes
do not show it, and alias-argument loops avoid it.

Unexplained, and not relied on: with generic-interface nodes (D), the
`Op<H> extends infer H2` conditional never reaches
`get_conditional_type_worker` with the heap as check type (8 permissive calls
in a whole 50-step run), so D + `infer` stays flat even with the trigger.

## Recommended representation

Candidate **A**, as the stage 4 runtime:

- **Heap** `[next, root]`: a 2-tuple built by a constructor alias
  (`HeapMk<Nx, R> = Nx extends unknown ? [Nx, R] : never`). `next` is the
  next free id. Ids are fixed-width hex strings and the path is most
  significant digit first. The width is chosen per program from its boot
  image plus headroom; growing the width means adding a root level.
- **Trie nodes**: 16-element tuples built by `Mk16<A0, …, A15>`, a
  conditional whose tuple elements are only its type parameters. Children are
  read as `N[Ix[D] & keyof N]`, and a node is rebuilt by
  `Mk16<N["0" & keyof N], …, V, …>`. Empty subtrees are shared constants.
- **Objects**: tuples of their fields (structs, slice headers, map buckets)
  built by a constructor alias, with fields read by index. 8 or 16 fields
  cost about the same. For larger objects, nest tuples of at most 16 fields.
  Interface-instantiation nodes (D) also work but cost ~30% more instantiations
  per write and ~8x the memory.
- Cost to beat in stage 4: ~60 per read, ~410 per write (a 5-level path
  copy plus a field rewrite), ~360 per alloc, and 11–15 per state step that
  passes the heap on.

## Rules for the emitter and runtime

- **H1. Nothing generic-looking reachable from the heap.** Every value stored
  in the heap is a literal, a top-level alias without type parameters, a
  non-generic interface, or the result of instantiating a constructor alias.
  Never store, or read out and store:
  - an object type literal (`{}`, `{ a: … }`) or mapped type written in
    source anywhere other than as the body of a top-level parameterless
    alias;
  - an uninstantiated deferred tuple;
  - a type parameter.

  Boot-image objects are emitted as `type ImgN = OMk<…>` (an instantiation)
  or a top-level parameterless alias. They contain no inline `{…}` and no
  inline literal tuples that mention aliases (write those as `Mk…<>` calls).
  Shapes and dispatch tables are non-generic interfaces, which are never
  walked.

- **H2. The heap (and anything holding it) is passed only as an alias type
  argument.** It never appears as the check type of a conditional:
  - no `H extends …`;
  - no `Store<…> extends infer h` to force a result;
  - no tuple pattern on a state tuple that holds it.

  Conditionals test small values (pc, tags, ids, flags). An op with several
  results returns a tuple that the _next_ alias receives as an argument and
  reads by indexed access (`R["0" & keyof R]`). H2 makes any H1 slip cost
  nothing, and avoids the one-off tuple-pattern and `inferc` costs above.
  Where an emitted segment must take state apart, take it apart by indexed
  access, not by pattern.

- **H3. Big tables are read as `K extends keyof T ? T[K] : never`,** never as
  `T[K & keyof T]`. The `&` form is fine only on small types (the 16-tuples
  of the trie).
- **H4. Constructors** (`Mk16`, `OMk`, `HeapMk`, …) are conditional aliases
  whose tuple elements are only their own type parameters. In tsrs a tuple
  literal in an alias is deferred when an element references an alias, even
  inside a conditional branch (`is_resolved_by_type_alias` includes
  `ConditionalType`, checker_11.rs:3380). Instantiated deferred tuples are not
  walked, but they resolve their elements lazily, so plain tuples are the
  predictable form.
- **H5. Cost tests.** Every runtime primitive gets a cost test at 0, 1k, 10k
  and 100k live objects on stock tsrs, failing if cost grows (this harness:
  `run.ts`). The emitter's output gets a diag check that `walk/op` (permissive
  and restrictive instantiations) is 0 per step and `rel/op` is a small
  constant.

## Snapshots

Snapshots are not needed for heap cost. They remain the way to go past one
checker's other limits, and the long run above shows the relation cache is
not one of them for this heap (flat at 2,697 entries). The plan's mid-run
start remains a testing tool. The 28k-vs-550k per chunk difference seen in
lua-in-types was cost 3 itself: a fresh process re-creates image values as
non-flagged instantiations.

## Reproducing

    node experiments/stage0/heap/run.ts --k 100 --jobs 2 --out .run/main.json \
      node=tuple obj=t16,lua,i8 bind=arg,infer,tuple,inferc op=none,read,write,alloc n=0,1024,10240,102400
    node experiments/stage0/heap/run.ts --k 100 --jobs 2 --out .run/main.json \
      node=iface obj=i16 bind=arg,infer,tuple,inferc op=none,read,write,alloc n=0,1024,10240,102400
    node experiments/stage0/heap/run.ts --k 20 --jobs 2 --out .run/main.json \
      node=tuple obj=t16 bind=arg,infer,tuple,inferc op=write n=0,1024,10240,102400 glit=1
    node experiments/stage0/heap/long.ts tuple t16 102400 500 100     # 50k writes
    sh experiments/stage0/heap/lua_repro.sh                             # cost 3 in lua-in-types

The diag columns need the instrumented build
(`experiments/stage0/heap/README.md`; add `--diag .run/target/release/tsrs`).
The full matrix takes ~15 minutes with 2 jobs.
